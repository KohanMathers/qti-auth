import type { CaptchaWidget } from '@qtiauth/captcha';
import { FLOW_BINDING_HEADER, type Router } from '@qtiauth/service-kit';
import * as z from 'zod';

import { findAccount, SIGNED_IN_STATES } from './accounts.ts';
import { isValidDateOfBirth } from './age.ts';
import { completeBind, issueBindCode } from './bind.ts';
import { bindStoreOf } from './bind-state.ts';
import {
  type CaptchaCheck,
  captchaFromForm,
  captchaMarkup,
  checkCaptcha,
  noteCaptchaAttempt,
} from './captcha.ts';
import { type SecondFactorMethod, totpEnrolled } from './factors.ts';
import {
  completeEmailVerification,
  completePasswordReset,
  completeSocialSignup,
  finishEmailChange,
  finishEmailRevert,
  finishSocial,
  finishTwoFactor,
  inspectPasswordReset,
  loginPassword,
  magicLinkEnabled,
  passkeysEnabled,
  passwordEnabled,
  registerWithPassword,
  sendMagicLink,
  sendPasswordReset,
  socialEnabled,
  startSocial,
  signup,
  totpEnabled,
  verify,
} from './flows.ts';
import { NO_STORE, revokedHeaders, sessionHeaders } from './headers.ts';
import { escapeHtml, hiddenInput, type HtmlPage, htmlResponse } from './html.ts';
import { preferredLocale } from './locale.ts';
import { identityMetrics } from './metrics.ts';
import { listPasskeys } from './passkeys.ts';
import type { PasswordPolicyReason } from './passwords.ts';
import { enabledSocialProviders } from './providers.ts';
import type { Context } from './service.ts';
import { signedIn as sessionUser } from './session-routes.ts';
import type { CreatedSession } from './sessions.ts';
import {
  accountPath,
  BIND_CALLBACK_PAGE,
  BIND_PAGE,
  CHANGE_EMAIL_PAGE,
  CONNECT_PAGE,
  encryptionKey,
  FORGOT_PASSWORD_PAGE,
  IDENTITIES_PAGE,
  LOGIN_PAGE,
  MAGIC_LINK_PAGE,
  MAGIC_LINK_START_PAGE,
  parseBindTarget,
  PASSKEY_PAGE,
  PASSKEYS_PAGE,
  REGISTER_PAGE,
  RESET_PASSWORD_PAGE,
  RETURN_TO,
  REVERT_EMAIL_PAGE,
  sessionClient,
  SIGNUP_CHOICE_PAGE,
  SOCIAL_CALLBACK_PAGE,
  SOCIAL_SIGNUP_PAGE,
  SOCIAL_START_PAGE,
  surfaceForHost,
  surfaceOrigin,
  surfacePath,
  TOTP_PAGE,
  TWO_FACTOR_PAGE,
  VERIFY_EMAIL_PAGE,
} from './settings.ts';
import { listSocialIdentities } from './social.ts';
import { beginTotpEnrol, confirmTotpEnrol, disableTotp } from './two-factor.ts';

const htmlResponses = { 200: { description: 'An HTML page' } };

type Page = Omit<HtmlPage, 'product'>;

const FORM_CONTENT_TYPE = /^application\/x-www-form-urlencoded\s*(?:;|$)/i;

async function readForm(request: Request): Promise<Record<string, string>> {
  if (!FORM_CONTENT_TYPE.test(request.headers.get('content-type') ?? '')) return {};
  return Object.fromEntries(new URLSearchParams(await request.text()));
}

function page(ctx: Context, content: Page): Response {
  return htmlResponse({ ...content, product: ctx.config.branding.product_name });
}

function paragraph(text: string): string {
  return `<p>${escapeHtml(text)}</p>`;
}

function alert(text: string): string {
  return `<p role="alert">${escapeHtml(text)}</p>`;
}

function disabled(ctx: Context): Response {
  return page(ctx, {
    status: 403,
    title: 'Magic links are turned off',
    body: paragraph('Sign in another way.'),
  });
}

function passwordDisabled(ctx: Context): Response {
  return page(ctx, {
    status: 403,
    title: 'Password sign-in is turned off',
    body: paragraph('Sign in another way.'),
  });
}

function passkeyDisabled(ctx: Context): Response {
  return page(ctx, {
    status: 403,
    title: 'Passkeys are turned off',
    body: paragraph('Sign in another way.'),
  });
}

function totpDisabled(ctx: Context): Response {
  return page(ctx, {
    status: 403,
    title: 'Authenticator apps are turned off',
    body: paragraph('Sign in another way.'),
  });
}

function invalidLink(ctx: Context): Response {
  return page(ctx, {
    status: 400,
    title: 'This link can’t be used',
    body: paragraph('It has expired or has already been used. Ask for a new link to sign in.'),
  });
}

function dateOfBirthForm(ctx: Context, signupToken: string, error?: string): Response {
  return page(ctx, {
    status: error === undefined ? 200 : 400,
    title: 'Create your account',
    body: `${error === undefined ? '' : alert(error)}
<form method="post" action="signup">
${hiddenInput('signup_token', signupToken)}
<p><label for="date_of_birth">Date of birth</label><br>
<input id="date_of_birth" name="date_of_birth" type="date" required></p>
<p><button type="submit">Create account</button></p>
</form>`,
  });
}

function signedIn(ctx: Context, session: CreatedSession, returnTo: string | null): Response {
  const headers = sessionHeaders(session);
  const target = safeReturnTo(returnTo ?? undefined);
  if (target !== null) {
    return new Response(null, {
      status: 303,
      headers: { ...headers, location: accountPath(ctx.config, target) },
    });
  }
  return page(ctx, {
    title: 'You’re signed in',
    headers,
    body: `<ul>
<li><a href="../api/v1/me">Your account</a></li>
<li><a href="../api/v1/sessions">Your sessions</a></li>
${passkeysEnabled(ctx) ? '<li><a href="passkeys">Passkeys</a></li>' : ''}
${totpEnabled(ctx) ? '<li><a href="totp">Authenticator app</a></li>' : ''}
${socialEnabled(ctx) ? '<li><a href="identities">Connected sign-in methods</a></li>' : ''}
</ul>
<form method="post" action="../api/v1/auth/logout"><button type="submit">Sign out</button></form>`,
  });
}

function passwordMessage(ctx: Context, reason: PasswordPolicyReason): string {
  switch (reason) {
    case 'too_short':
      return `Use at least ${String(ctx.config.password.min_length)} characters.`;
    case 'too_long':
      return `Use at most ${String(ctx.config.password.max_length)} characters.`;
    case 'need_lower':
      return 'Add a lowercase letter.';
    case 'need_upper':
      return 'Add an uppercase letter.';
    case 'need_digit':
      return 'Add a number.';
    case 'need_symbol':
      return 'Add a symbol.';
    case 'contains_identifier':
      return 'Don’t use your email address in your password.';
    case 'breached':
      return 'This password appears in a data breach. Choose another.';
  }
}

function captchaBlock(widget: CaptchaWidget | undefined): string {
  if (widget === undefined) return '';
  return captchaMarkup(widget);
}

function socialButtons(ctx: Context, kind: 'signin' | 'signup', returnTo?: string | null): string {
  const providers = enabledSocialProviders(ctx.config.features.auth.social);
  if (providers.length === 0) return '';
  const verb = kind === 'signup' ? 'Sign up' : 'Sign in';
  const query = returnTo ? `?return_to=${encodeURIComponent(returnTo)}` : '';
  return providers
    .map(
      (provider) =>
        `<p><a href="social/${encodeURIComponent(provider.id)}/start${query}">${verb} with ${escapeHtml(provider.name)}</a></p>`,
    )
    .join('\n');
}

function safeReturnTo(value: string | undefined): string | null {
  if (value === undefined || value.length > 2048 || !RETURN_TO.test(value)) return null;
  return value;
}

function redirect(location: string, headers: Record<string, string> = {}): Response {
  return new Response(null, { status: 302, headers: { ...headers, location } });
}

function bindFailed(ctx: Context): Response {
  return page(ctx, {
    status: 400,
    title: 'This sign-in couldn’t be continued',
    body: paragraph('Open the page you wanted again, or sign in on the account site first.'),
  });
}

function captchaAlert(result: CaptchaCheck): string {
  if (result.status === 'invalid') return 'That CAPTCHA was not completed correctly. Try again.';
  return 'Complete the CAPTCHA to continue.';
}

function socialSignupForm(
  ctx: Context,
  challenge: string,
  needsEmail: boolean,
  error?: string,
): Response {
  return page(ctx, {
    status: error === undefined ? 200 : 400,
    title: 'Create your account',
    body: `${error === undefined ? '' : alert(error)}
<form method="post" action="signup">
${hiddenInput('challenge', challenge)}
${
  needsEmail
    ? `${hiddenInput('needs_email', '1')}<p><label for="email">Email</label><br>
<input id="email" name="email" type="email" autocomplete="email" required></p>`
    : ''
}
<p><label for="date_of_birth">Date of birth</label><br>
<input id="date_of_birth" name="date_of_birth" type="date" required></p>
<p><button type="submit">Create account</button></p>
</form>`,
  });
}

function socialResultPage(
  ctx: Context,
  result: Awaited<ReturnType<typeof finishSocial>>,
): Response {
  switch (result.status) {
    case 'invalid':
    case 'denied':
      return page(ctx, {
        status: 400,
        title: 'Sign-in didn’t finish',
        body: paragraph('Sign in with this provider again.'),
      });
    case 'provider_unavailable':
      return page(ctx, {
        status: 502,
        title: 'This sign-in provider is unavailable',
        body: paragraph('Try again in a moment.'),
      });
    case 'identity_in_use':
      return page(ctx, {
        status: 409,
        title: 'Already connected',
        body: paragraph('This sign-in method is already connected to another account.'),
      });
    case 'account_limit':
      return page(ctx, {
        status: 409,
        title: 'You can’t create another account',
        body: paragraph('This email address already has as many accounts as it can have.'),
      });
    case 'parental_consent_required':
      return page(ctx, {
        status: 403,
        title: 'You can’t create an account yet',
        body: paragraph(
          `People under ${String(ctx.config.parental.consent_age)} need a parent or guardian to approve their account, and that isn’t available yet.`,
        ),
      });
    case 'linked':
      return new Response(null, {
        status: 303,
        headers: { location: accountPath(ctx.config, IDENTITIES_PAGE) },
      });
    case 'signup_required': {
      const url = new URL(accountPath(ctx.config, SOCIAL_SIGNUP_PAGE), 'http://localhost');
      url.searchParams.set('challenge', result.challenge);
      if (result.needsEmail) url.searchParams.set('needs_email', '1');
      return new Response(null, { status: 303, headers: { location: url.pathname + url.search } });
    }
    case 'signed_in':
      return signedIn(ctx, result.session, result.returnTo);
  }
}

function registerForm(
  ctx: Context,
  values: { email?: string; dateOfBirth?: string },
  error?: string,
  widget?: CaptchaWidget,
): Response {
  return page(ctx, {
    status: error === undefined ? 200 : 400,
    title: 'Sign up with a password',
    body: `${error === undefined ? '' : alert(error)}
<form method="post" action="register">
<p><label for="email">Email</label><br>
<input id="email" name="email" type="email" autocomplete="username" required value="${escapeHtml(values.email ?? '')}"></p>
<p><label for="password">Password</label><br>
<input id="password" name="password" type="password" autocomplete="new-password" maxlength="256" required></p>
<p><label for="date_of_birth">Date of birth</label><br>
<input id="date_of_birth" name="date_of_birth" type="date" required value="${escapeHtml(values.dateOfBirth ?? '')}"></p>
${captchaBlock(widget)}
<p><button type="submit">Create account</button></p>
</form>
<p><a href="signup">Other ways to sign up</a></p>`,
  });
}

function loginForm(
  ctx: Context,
  email: string,
  error?: string,
  widget?: CaptchaWidget,
  status?: number,
  returnTo?: string | null,
): Response {
  const bounce = returnTo ? `${hiddenInput('return_to', returnTo)}\n` : '';
  return page(ctx, {
    status: status ?? (error === undefined ? 200 : 401),
    title: `Sign in to ${ctx.config.branding.product_name}`,
    body: `${error === undefined ? '' : alert(error)}
<form method="post" action="login">
${bounce}<p><label for="email">Email</label><br>
<input id="email" name="email" type="email" autocomplete="username" required value="${escapeHtml(email)}"></p>
<p><label for="password">Password</label><br>
<input id="password" name="password" type="password" autocomplete="current-password" maxlength="256" required></p>
${captchaBlock(widget)}
<p><button type="submit">Sign in</button></p>
</form>
${passkeysEnabled(ctx) ? '<p><a href="passkey">Sign in with a passkey</a></p>' : ''}
${socialButtons(ctx, 'signin', returnTo)}
<p><a href="forgot-password">Forgot password</a></p>`,
  });
}

function twoFactorForm(
  ctx: Context,
  challenge: string,
  methods: readonly SecondFactorMethod[],
  error?: string,
): Response {
  const totp = methods.includes('totp');
  const recovery = methods.includes('recovery');
  const passkey = methods.includes('passkey');
  return page(ctx, {
    status: error === undefined ? 200 : 400,
    title: 'Confirm it’s you',
    body: `${error === undefined ? '' : alert(error)}
<form method="post" action="two-factor">
${hiddenInput('challenge', challenge)}
${
  totp
    ? `<p><label for="totp">Authenticator code</label><br>
<input id="totp" name="totp" inputmode="numeric" autocomplete="one-time-code"></p>`
    : ''
}
${
  recovery
    ? `<p><label for="recovery_code">Recovery code</label><br>
<input id="recovery_code" name="recovery_code" autocomplete="off"></p>`
    : ''
}
<p><button type="submit">Continue</button></p>
</form>
${passkey ? `<p><a href="passkey?second_factor=${encodeURIComponent(challenge)}">Use a passkey</a></p>` : ''}`,
  });
}

function totpStartForm(ctx: Context, error?: string): Response {
  return page(ctx, {
    status: error === undefined ? 200 : 400,
    title: 'Set up an authenticator app',
    body: `${error === undefined ? '' : alert(error)}
<form method="post" action="totp">
<p><button type="submit">Set up</button></p>
</form>`,
  });
}

function totpConfirmForm(
  ctx: Context,
  challenge: string,
  secret: string,
  otpauth: string,
  error?: string,
): Response {
  return page(ctx, {
    status: error === undefined ? 200 : 400,
    title: 'Confirm your authenticator app',
    body: `${error === undefined ? '' : alert(error)}
<p>Secret: <code>${escapeHtml(secret)}</code></p>
<p><a href="${escapeHtml(otpauth)}">Add to authenticator</a></p>
<form method="post" action="totp">
${hiddenInput('challenge', challenge)}
${hiddenInput('secret', secret)}
${hiddenInput('otpauth', otpauth)}
<p><label for="code">Authenticator code</label><br>
<input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" required></p>
<p><button type="submit">Confirm</button></p>
</form>`,
  });
}

function totpDisableForm(ctx: Context, error?: string): Response {
  return page(ctx, {
    status: error === undefined ? 200 : 400,
    title: 'Authenticator app is on',
    body: `${error === undefined ? '' : alert(error)}
<form method="post" action="totp">
<p><label for="code">Authenticator code</label><br>
<input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" required></p>
<p><button type="submit">Turn off</button></p>
</form>`,
  });
}

function passkeySignInMarkup(secondFactor: string | undefined): string {
  const extra =
    secondFactor === undefined
      ? ''
      : `<p>After a password sign-in, finish with <code>POST /api/v1/auth/passkey/authenticate/start</code> and the second-factor challenge.</p>`;
  return `${paragraph('Passkey sign-in uses the JSON API: start at /api/v1/auth/passkey/authenticate/start, then POST the authenticator assertion to /api/v1/auth/passkey/authenticate.')}${extra}`;
}

function resetForm(
  ctx: Context,
  token: string,
  userId: string | undefined,
  error?: string,
): Response {
  return page(ctx, {
    status: error === undefined ? 200 : 400,
    title: 'Choose a new password',
    body: `${error === undefined ? '' : alert(error)}
<form method="post" action="reset-password">
${hiddenInput('token', token)}
${userId === undefined ? '' : `${hiddenInput('user_id', userId)}\n`}
<p><label for="password">New password</label><br>
<input id="password" name="password" type="password" autocomplete="new-password" maxlength="256" required></p>
<p><label><input type="checkbox" name="keep_other_sessions" value="1"> Don’t log me out of other sessions</label></p>
<p><button type="submit">Save password</button></p>
</form>`,
  });
}

function magicLinkStartForm(
  ctx: Context,
  email: string,
  error?: string,
  widget?: CaptchaWidget,
): Response {
  return page(ctx, {
    status: error === undefined ? 200 : 400,
    title: `Sign in to ${ctx.config.branding.product_name}`,
    body: `${error === undefined ? '' : alert(error)}
<form method="post" action="start">
<p><label for="email">Email</label><br>
<input id="email" name="email" type="email" autocomplete="username" required value="${escapeHtml(email)}"></p>
${captchaBlock(widget)}
<p><button type="submit">Email me a link</button></p>
</form>`,
  });
}

function localeOf(ctx: Context, request: Request): string {
  return preferredLocale(request.headers.get('accept-language')) ?? ctx.config.email.default_locale;
}

export function pageRoutes(router: Router<Context>): void {
  router.route({
    method: 'GET',
    path: MAGIC_LINK_PAGE,
    operation_id: 'magicLinkPage',
    summary: 'Page asking to confirm a magic-link sign-in',
    description:
      'Opening a magic link only shows this page, so email scanners that follow links don’t use them up. Interim page until the web app replaces it.',
    tags: ['pages'],
    auth: 'none',
    rate_limit: 'global',
    request: { query: z.object({ token: z.string().max(256).optional() }) },
    responses: htmlResponses,
    handler: ({ ctx, query }) => {
      if (!magicLinkEnabled(ctx)) return Promise.resolve(disabled(ctx));
      if (query.token === undefined) return Promise.resolve(invalidLink(ctx));
      return Promise.resolve(
        page(ctx, {
          title: `Sign in to ${ctx.config.branding.product_name}`,
          body: `<form method="post" action="magic-link">
${hiddenInput('token', query.token)}
<p><button type="submit">Continue</button></p>
</form>`,
        }),
      );
    },
  });

  router.route({
    method: 'POST',
    path: MAGIC_LINK_PAGE,
    operation_id: 'magicLinkPageConfirm',
    summary: 'Confirm a magic-link sign-in from the confirmation page',
    description: 'Takes a form with token and, after choosing an account, user_id.',
    tags: ['pages'],
    auth: 'none',
    rate_limit: 'auth_verify',
    responses: { ...htmlResponses, 303: { description: 'Signed in, going to return_to' } },
    handler: async ({ ctx, request, log, identity }) => {
      if (!magicLinkEnabled(ctx)) return disabled(ctx);
      const form = await readForm(request);
      const token = form['token'] ?? '';
      const userId = form['user_id'];
      const result = await verify(
        { ctx, request, log, identity },
        { token, userId: z.uuid().safeParse(userId).success ? userId : undefined },
      );
      switch (result.status) {
        case 'invalid':
          return invalidLink(ctx);
        case 'signup_required':
          return dateOfBirthForm(ctx, result.signupToken);
        case 'signed_in':
          return signedIn(ctx, result.session, result.returnTo);
        case 'choose_account':
          return page(ctx, {
            title: 'Choose an account',
            body: `<form method="post" action="magic-link">
${hiddenInput('token', token)}
${result.accounts
  .map(
    (account, index) =>
      `<p><label><input type="radio" name="user_id" value="${escapeHtml(account.id)}" required${index === 0 ? ' checked' : ''}> Account created ${escapeHtml(account.created_at.toISOString().slice(0, 10))}</label></p>`,
  )
  .join('\n')}
<p><button type="submit">Continue</button></p>
</form>`,
          });
      }
    },
  });

  router.route({
    method: 'GET',
    path: SIGNUP_CHOICE_PAGE,
    operation_id: 'signupChoicePage',
    summary: 'Choose a sign-up method',
    description: 'Interim page until the web app replaces it.',
    tags: ['pages'],
    auth: 'none',
    rate_limit: 'global',
    responses: htmlResponses,
    handler: ({ ctx }) => {
      const password = passwordEnabled(ctx);
      const magic = magicLinkEnabled(ctx);
      const social = enabledSocialProviders(ctx.config.features.auth.social).length > 0;
      if (!password && !magic && !social) {
        return Promise.resolve(
          page(ctx, {
            status: 403,
            title: 'Sign-up is turned off',
            body: paragraph('No sign-up methods are available.'),
          }),
        );
      }
      return Promise.resolve(
        page(ctx, {
          title: 'Create your account',
          body: `${password ? `<p><a href="register">Sign up with a password</a></p>` : ''}
${magic ? `<p><a href="magic-link/start">Sign up with a magic link</a></p>` : ''}
${socialButtons(ctx, 'signup')}
<p><a href="login">Already have an account? Sign in</a></p>`,
        }),
      );
    },
  });

  router.route({
    method: 'POST',
    path: SIGNUP_CHOICE_PAGE,
    operation_id: 'signupPage',
    summary: 'Create an account from the date of birth page',
    description: 'Takes a form with signup_token and date_of_birth.',
    tags: ['pages'],
    auth: 'none',
    rate_limit: 'auth_verify',
    responses: { ...htmlResponses, 303: { description: 'Signed in, going to return_to' } },
    handler: async ({ ctx, request, log, identity }) => {
      if (!magicLinkEnabled(ctx)) return disabled(ctx);
      const form = await readForm(request);
      const signupToken = form['signup_token'] ?? '';
      const dateOfBirth = form['date_of_birth'] ?? '';
      if (!isValidDateOfBirth(dateOfBirth, new Date())) {
        return dateOfBirthForm(ctx, signupToken, 'Enter your real date of birth.');
      }
      const result = await signup({ ctx, request, log, identity }, { signupToken, dateOfBirth });
      switch (result.status) {
        case 'invalid':
          return invalidLink(ctx);
        case 'account_limit':
          return page(ctx, {
            status: 409,
            title: 'You can’t create another account',
            body: paragraph('This email address already has as many accounts as it can have.'),
          });
        case 'parental_consent_required':
          return page(ctx, {
            status: 403,
            title: 'You can’t create an account yet',
            body: paragraph(
              `People under ${String(ctx.config.parental.consent_age)} need a parent or guardian to approve their account, and that isn’t available yet.`,
            ),
          });
        case 'signed_in':
          return signedIn(ctx, result.session, result.returnTo);
      }
    },
  });

  router.route({
    method: 'GET',
    path: MAGIC_LINK_START_PAGE,
    operation_id: 'magicLinkStartPage',
    summary: 'Ask for a magic link',
    tags: ['pages'],
    auth: 'none',
    rate_limit: 'global',
    responses: htmlResponses,
    handler: ({ ctx }) => {
      if (!magicLinkEnabled(ctx)) return Promise.resolve(disabled(ctx));
      return Promise.resolve(magicLinkStartForm(ctx, ''));
    },
  });

  router.route({
    method: 'POST',
    path: MAGIC_LINK_START_PAGE,
    operation_id: 'magicLinkStartPageSubmit',
    summary: 'Send a magic link from the request page',
    tags: ['pages'],
    auth: 'none',
    rate_limit: 'magic_link',
    responses: htmlResponses,
    handler: async ({ ctx, request, log, identity }) => {
      if (!magicLinkEnabled(ctx)) return disabled(ctx);
      const form = await readForm(request);
      const email = form['email'] ?? '';
      if (!z.email().safeParse(email).success) {
        return magicLinkStartForm(ctx, email, 'Enter a valid email address.');
      }
      const captcha = await checkCaptcha(ctx, request, 'magic_link', captchaFromForm(form));
      if (captcha.status !== 'ok') {
        return magicLinkStartForm(ctx, email, captchaAlert(captcha), captcha.widget);
      }
      await sendMagicLink(
        { ctx, request, log, identity },
        { email, locale: localeOf(ctx, request), returnTo: null },
      );
      await noteCaptchaAttempt(ctx, request, 'magic_link');
      return page(ctx, {
        title: 'Check your email',
        body: paragraph('If an account can use this address, we’ve sent a link.'),
      });
    },
  });

  router.route({
    method: 'GET',
    path: REGISTER_PAGE,
    operation_id: 'registerPage',
    summary: 'Password signup form',
    tags: ['pages'],
    auth: 'none',
    rate_limit: 'global',
    responses: htmlResponses,
    handler: ({ ctx }) => {
      if (!passwordEnabled(ctx)) return Promise.resolve(passwordDisabled(ctx));
      return Promise.resolve(registerForm(ctx, {}));
    },
  });

  router.route({
    method: 'POST',
    path: REGISTER_PAGE,
    operation_id: 'registerPageSubmit',
    summary: 'Create an account from the password signup form',
    tags: ['pages'],
    auth: 'none',
    rate_limit: 'auth_password',
    responses: htmlResponses,
    handler: async ({ ctx, request, log, identity }) => {
      if (!passwordEnabled(ctx)) return passwordDisabled(ctx);
      const form = await readForm(request);
      const email = form['email'] ?? '';
      const password = form['password'] ?? '';
      const dateOfBirth = form['date_of_birth'] ?? '';
      if (!z.email().safeParse(email).success) {
        return registerForm(ctx, { email, dateOfBirth }, 'Enter a valid email address.');
      }
      if (!isValidDateOfBirth(dateOfBirth, new Date())) {
        return registerForm(ctx, { email, dateOfBirth }, 'Enter your real date of birth.');
      }
      const captcha = await checkCaptcha(ctx, request, 'password_signup', captchaFromForm(form));
      if (captcha.status !== 'ok') {
        return registerForm(ctx, { email, dateOfBirth }, captchaAlert(captcha), captcha.widget);
      }
      const result = await registerWithPassword(
        { ctx, request, log, identity },
        { email, password, dateOfBirth, locale: localeOf(ctx, request) },
      );
      await noteCaptchaAttempt(ctx, request, 'password_signup');
      switch (result.status) {
        case 'rejected': {
          const next = await checkCaptcha(ctx, request, 'password_signup', undefined);
          return registerForm(
            ctx,
            { email, dateOfBirth },
            passwordMessage(ctx, result.reason),
            next.status === 'ok' ? undefined : next.widget,
          );
        }
        case 'account_limit':
          return page(ctx, {
            status: 409,
            title: 'You can’t create another account',
            body: paragraph('This email address already has as many accounts as it can have.'),
          });
        case 'parental_consent_required':
          return page(ctx, {
            status: 403,
            title: 'You can’t create an account yet',
            body: paragraph(
              `People under ${String(ctx.config.parental.consent_age)} need a parent or guardian to approve their account, and that isn’t available yet.`,
            ),
          });
        case 'created':
          return page(ctx, {
            title: 'Check your email',
            body: paragraph('We’ve sent a link to confirm your email address.'),
          });
      }
    },
  });

  router.route({
    method: 'GET',
    path: LOGIN_PAGE,
    operation_id: 'loginPage',
    summary: 'Password sign-in form',
    tags: ['pages'],
    auth: 'none',
    rate_limit: 'global',
    request: { query: z.object({ return_to: z.string().max(2048).optional() }) },
    responses: htmlResponses,
    handler: ({ ctx, query }) => {
      if (!passwordEnabled(ctx)) return Promise.resolve(passwordDisabled(ctx));
      return Promise.resolve(
        loginForm(ctx, '', undefined, undefined, undefined, safeReturnTo(query.return_to)),
      );
    },
  });

  router.route({
    method: 'POST',
    path: LOGIN_PAGE,
    operation_id: 'loginPageSubmit',
    summary: 'Sign in from the password form',
    tags: ['pages'],
    auth: 'none',
    rate_limit: 'auth_password',
    responses: { ...htmlResponses, 303: { description: 'Signed in, going to return_to' } },
    handler: async ({ ctx, request, log, identity }) => {
      if (!passwordEnabled(ctx)) return passwordDisabled(ctx);
      const form = await readForm(request);
      const email = form['email'] ?? '';
      const password = form['password'] ?? '';
      const returnTo = safeReturnTo(form['return_to']);
      const captcha = await checkCaptcha(ctx, request, 'password_login', captchaFromForm(form));
      if (captcha.status !== 'ok') {
        return loginForm(ctx, email, captchaAlert(captcha), captcha.widget, 403, returnTo);
      }
      const result = await loginPassword({ ctx, request, log, identity }, { email, password });
      if (result.status === 'invalid') {
        const next = await checkCaptcha(ctx, request, 'password_login', undefined);
        return loginForm(
          ctx,
          email,
          'Email or password incorrect',
          next.status === 'ok' ? undefined : next.widget,
          undefined,
          returnTo,
        );
      }
      if (result.status === 'second_factor_required') {
        return twoFactorForm(ctx, result.challenge, result.methods);
      }
      return signedIn(ctx, result.session, returnTo);
    },
  });

  router.route({
    method: 'GET',
    path: FORGOT_PASSWORD_PAGE,
    operation_id: 'forgotPasswordPage',
    summary: 'Ask for a password reset link',
    tags: ['pages'],
    auth: 'none',
    rate_limit: 'global',
    responses: htmlResponses,
    handler: ({ ctx }) => {
      if (!passwordEnabled(ctx)) return Promise.resolve(passwordDisabled(ctx));
      return Promise.resolve(
        page(ctx, {
          title: 'Forgot your password',
          body: `<form method="post" action="forgot-password">
<p><label for="email">Email</label><br>
<input id="email" name="email" type="email" autocomplete="username" required></p>
<p><button type="submit">Email me a link</button></p>
</form>`,
        }),
      );
    },
  });

  router.route({
    method: 'POST',
    path: FORGOT_PASSWORD_PAGE,
    operation_id: 'forgotPasswordPageSubmit',
    summary: 'Send a password reset link from the form',
    tags: ['pages'],
    auth: 'none',
    rate_limit: 'magic_link',
    responses: htmlResponses,
    handler: async ({ ctx, request, log, identity }) => {
      if (!passwordEnabled(ctx)) return passwordDisabled(ctx);
      const email = (await readForm(request))['email'] ?? '';
      if (z.email().safeParse(email).success) {
        await sendPasswordReset(
          { ctx, request, log, identity },
          { email, locale: localeOf(ctx, request) },
        );
      }
      return page(ctx, {
        title: 'Check your email',
        body: paragraph('If an account can use this address, we’ve sent a link.'),
      });
    },
  });

  router.route({
    method: 'GET',
    path: RESET_PASSWORD_PAGE,
    operation_id: 'resetPasswordPage',
    summary: 'Page asking to confirm a password reset',
    description:
      'Opening a reset link only shows this page, so email scanners that follow links don’t use them up.',
    tags: ['pages'],
    auth: 'none',
    rate_limit: 'global',
    request: { query: z.object({ token: z.string().max(256).optional() }) },
    responses: htmlResponses,
    handler: ({ ctx, query }) => {
      if (!passwordEnabled(ctx)) return Promise.resolve(passwordDisabled(ctx));
      if (query.token === undefined) return Promise.resolve(invalidLink(ctx));
      return Promise.resolve(
        page(ctx, {
          title: 'Reset your password',
          body: `<form method="post" action="reset-password">
${hiddenInput('token', query.token)}
<p><button type="submit">Continue</button></p>
</form>`,
        }),
      );
    },
  });

  router.route({
    method: 'POST',
    path: RESET_PASSWORD_PAGE,
    operation_id: 'resetPasswordPageSubmit',
    summary: 'Confirm a reset link or save a new password',
    tags: ['pages'],
    auth: 'none',
    rate_limit: 'auth_verify',
    responses: { ...htmlResponses, 303: { description: 'Signed in, going to return_to' } },
    handler: async ({ ctx, request, log, identity }) => {
      if (!passwordEnabled(ctx)) return passwordDisabled(ctx);
      const form = await readForm(request);
      const token = form['token'] ?? '';
      const userId = z.uuid().safeParse(form['user_id']).success ? form['user_id'] : undefined;
      const password = form['password'];
      if (password === undefined) {
        const peek = await inspectPasswordReset({ ctx, request, log, identity }, { token, userId });
        switch (peek.status) {
          case 'invalid':
            return invalidLink(ctx);
          case 'choose_account':
            return page(ctx, {
              title: 'Choose an account',
              body: `<form method="post" action="reset-password">
${hiddenInput('token', token)}
${peek.accounts
  .map(
    (account, index) =>
      `<p><label><input type="radio" name="user_id" value="${escapeHtml(account.id)}" required${index === 0 ? ' checked' : ''}> Account created ${escapeHtml(account.created_at.toISOString().slice(0, 10))}</label></p>`,
  )
  .join('\n')}
<p><button type="submit">Continue</button></p>
</form>`,
            });
          case 'ready':
            return resetForm(ctx, token, userId);
        }
      }
      const result = await completePasswordReset(
        { ctx, request, log, identity },
        {
          token,
          password,
          keepOtherSessions: form['keep_other_sessions'] === '1',
          userId,
        },
      );
      switch (result.status) {
        case 'invalid':
          return invalidLink(ctx);
        case 'choose_account':
          return page(ctx, {
            title: 'Choose an account',
            body: `<form method="post" action="reset-password">
${hiddenInput('token', token)}
${result.accounts
  .map(
    (account, index) =>
      `<p><label><input type="radio" name="user_id" value="${escapeHtml(account.id)}" required${index === 0 ? ' checked' : ''}> Account created ${escapeHtml(account.created_at.toISOString().slice(0, 10))}</label></p>`,
  )
  .join('\n')}
<p><button type="submit">Continue</button></p>
</form>`,
          });
        case 'rejected':
          return resetForm(ctx, token, userId, passwordMessage(ctx, result.reason));
        case 'signed_in':
          return signedIn(
            ctx,
            { ...result.session, evicted: [...result.session.evicted, ...result.revoked] },
            null,
          );
      }
    },
  });

  router.route({
    method: 'GET',
    path: VERIFY_EMAIL_PAGE,
    operation_id: 'verifyEmailPage',
    summary: 'Page asking to confirm an email address',
    description:
      'Opening a verification link only shows this page, so email scanners that follow links don’t use them up.',
    tags: ['pages'],
    auth: 'none',
    rate_limit: 'global',
    request: { query: z.object({ token: z.string().max(256).optional() }) },
    responses: htmlResponses,
    handler: ({ ctx, query }) => {
      if (!passwordEnabled(ctx)) return Promise.resolve(passwordDisabled(ctx));
      if (query.token === undefined) return Promise.resolve(invalidLink(ctx));
      return Promise.resolve(
        page(ctx, {
          title: 'Confirm your email',
          body: `<form method="post" action="verify-email">
${hiddenInput('token', query.token)}
<p><button type="submit">Continue</button></p>
</form>`,
        }),
      );
    },
  });

  router.route({
    method: 'POST',
    path: VERIFY_EMAIL_PAGE,
    operation_id: 'verifyEmailPageSubmit',
    summary: 'Confirm an email address from the confirmation page',
    tags: ['pages'],
    auth: 'none',
    rate_limit: 'auth_verify',
    responses: { ...htmlResponses, 303: { description: 'Signed in, going to return_to' } },
    handler: async ({ ctx, request, log, identity }) => {
      if (!passwordEnabled(ctx)) return passwordDisabled(ctx);
      const token = (await readForm(request))['token'] ?? '';
      const result = await completeEmailVerification({ ctx, request, log, identity }, { token });
      if (result.status === 'invalid') return invalidLink(ctx);
      return signedIn(ctx, result.session, null);
    },
  });

  router.route({
    method: 'GET',
    path: TWO_FACTOR_PAGE,
    operation_id: 'twoFactorPage',
    summary: 'Enter an authenticator or recovery code after password sign-in',
    tags: ['pages'],
    auth: 'none',
    rate_limit: 'global',
    request: { query: z.object({ challenge: z.string().max(256).optional() }) },
    responses: htmlResponses,
    handler: ({ ctx, query }) => {
      if (query.challenge === undefined) {
        return Promise.resolve(
          page(ctx, {
            status: 400,
            title: 'Sign in again',
            body: paragraph('This confirmation has expired. Sign in with your password again.'),
          }),
        );
      }
      return Promise.resolve(twoFactorForm(ctx, query.challenge, ['totp', 'recovery', 'passkey']));
    },
  });

  router.route({
    method: 'POST',
    path: TWO_FACTOR_PAGE,
    operation_id: 'twoFactorPageSubmit',
    summary: 'Confirm a second factor from the form',
    tags: ['pages'],
    auth: 'none',
    rate_limit: 'auth_password',
    responses: { ...htmlResponses, 303: { description: 'Signed in, going to return_to' } },
    handler: async ({ ctx, request, log, identity }) => {
      const form = await readForm(request);
      const challenge = form['challenge'] ?? '';
      const totpRaw = form['totp']?.trim();
      const recoveryRaw = form['recovery_code']?.trim();
      const totp = totpRaw === undefined || totpRaw === '' ? undefined : totpRaw;
      const recoveryCode =
        recoveryRaw === undefined || recoveryRaw === '' ? undefined : recoveryRaw;
      const result = await finishTwoFactor(
        { ctx, request, log, identity },
        { challenge, totp, recoveryCode },
      );
      if (result.status === 'invalid') {
        return twoFactorForm(
          ctx,
          challenge,
          ['totp', 'recovery', 'passkey'],
          'This confirmation has expired. Sign in with your password again.',
        );
      }
      if (result.status === 'wrong_code') {
        return twoFactorForm(
          ctx,
          challenge,
          ['totp', 'recovery', 'passkey'],
          totp !== undefined
            ? 'That authenticator code is incorrect.'
            : 'That recovery code is incorrect.',
        );
      }
      return signedIn(ctx, result.session, null);
    },
  });

  router.route({
    method: 'GET',
    path: TOTP_PAGE,
    operation_id: 'totpPage',
    summary: 'Set up or turn off an authenticator app',
    tags: ['pages'],
    auth: 'session',
    allow_account_states: SIGNED_IN_STATES,
    allow_pending_legal: true,
    allow_pending_parental_consent: true,
    allow_pending_2fa_enrolment: true,
    rate_limit: 'global',
    responses: htmlResponses,
    handler: async ({ ctx, identity }) => {
      if (!totpEnabled(ctx)) return totpDisabled(ctx);
      const { userId } = sessionUser(identity);
      if (await totpEnrolled(ctx.db, userId)) {
        return totpDisableForm(ctx);
      }
      return totpStartForm(ctx);
    },
  });

  router.route({
    method: 'POST',
    path: TOTP_PAGE,
    operation_id: 'totpPageSubmit',
    summary: 'Start, confirm or turn off authenticator-app sign-in from the form',
    tags: ['pages'],
    auth: 'session',
    allow_account_states: SIGNED_IN_STATES,
    allow_pending_legal: true,
    allow_pending_parental_consent: true,
    allow_pending_2fa_enrolment: true,
    rate_limit: 'global',
    responses: htmlResponses,
    handler: async ({ ctx, identity, request }) => {
      if (!totpEnabled(ctx)) return totpDisabled(ctx);
      const { userId, sessionId } = sessionUser(identity);
      const form = await readForm(request);
      const code = form['code'] ?? '';
      const challenge = form['challenge'];
      if (challenge !== undefined) {
        const result = await confirmTotpEnrol(ctx.db, {
          userId,
          challenge,
          code,
          key: encryptionKey(ctx.config),
          now: new Date(),
        });
        if (result.status === 'wrong_code') {
          return totpConfirmForm(
            ctx,
            challenge,
            form['secret'] ?? '',
            form['otpauth'] ?? '',
            'That code is incorrect.',
          );
        }
        if (result.status !== 'enabled')
          return totpStartForm(ctx, 'Start again from the beginning.');
        return page(ctx, {
          title: 'Authenticator app is on',
          headers: revokedHeaders([sessionId]),
          body: `${paragraph('Store these recovery codes. Each works once.')}<pre>${escapeHtml(result.recoveryCodes.join('\n'))}</pre>
${passkeysEnabled(ctx) ? '<p><a href="passkeys">Passkeys</a></p>' : ''}`,
        });
      }
      if (code !== '') {
        const result = await disableTotp(ctx.db, {
          userId,
          code,
          key: encryptionKey(ctx.config),
          now: new Date(),
        });
        if (result === 'wrong_code') return totpDisableForm(ctx, 'That code is incorrect.');
        if (result === 'not_enabled') return totpStartForm(ctx);
        return page(ctx, {
          title: 'Authenticator app is off',
          headers: revokedHeaders([sessionId]),
          body: paragraph('You can set it up again at any time.'),
        });
      }
      const account = await findAccount(ctx.db, userId);
      if (!account) {
        return page(ctx, {
          status: 404,
          title: 'Account not found',
          body: paragraph('Sign in again.'),
        });
      }
      const started = await beginTotpEnrol(ctx.db, {
        userId,
        email: account.email,
        issuer: ctx.config.branding.product_name,
        now: new Date(),
      });
      if (started.status === 'already_enabled') return totpDisableForm(ctx);
      return totpConfirmForm(ctx, started.challenge, started.secret, started.otpauth);
    },
  });

  router.route({
    method: 'GET',
    path: PASSKEY_PAGE,
    operation_id: 'passkeyPage',
    summary: 'Sign in with a passkey',
    tags: ['pages'],
    auth: 'none',
    rate_limit: 'global',
    request: {
      query: z.object({ second_factor: z.string().max(256).optional() }),
    },
    responses: htmlResponses,
    handler: ({ ctx, query }) => {
      if (!passkeysEnabled(ctx)) return Promise.resolve(passkeyDisabled(ctx));
      return Promise.resolve(
        page(ctx, {
          title: 'Sign in with a passkey',
          body: passkeySignInMarkup(query.second_factor),
        }),
      );
    },
  });

  router.route({
    method: 'GET',
    path: PASSKEYS_PAGE,
    operation_id: 'passkeysPage',
    summary: 'Manage passkeys on this account',
    tags: ['pages'],
    auth: 'session',
    allow_account_states: SIGNED_IN_STATES,
    allow_pending_legal: true,
    allow_pending_parental_consent: true,
    allow_pending_2fa_enrolment: true,
    rate_limit: 'global',
    responses: htmlResponses,
    handler: async ({ ctx, identity }) => {
      if (!passkeysEnabled(ctx)) return passkeyDisabled(ctx);
      const { userId } = sessionUser(identity);
      const passkeys = await listPasskeys(ctx.db, userId);
      const items =
        passkeys.length === 0
          ? paragraph('No passkeys yet.')
          : `<ul>${passkeys
              .map((passkey) => `<li>${escapeHtml(passkey.name)}</li>`)
              .join('')}</ul>`;
      return page(ctx, {
        title: 'Passkeys',
        body: `${items}
${paragraph('Register a passkey with POST /api/v1/me/passkeys/register/start, then POST the attestation to /api/v1/me/passkeys/register.')}
${totpEnabled(ctx) ? '<p><a href="totp">Authenticator app</a></p>' : ''}
${socialEnabled(ctx) ? '<p><a href="identities">Connected sign-in methods</a></p>' : ''}`,
      });
    },
  });

  router.route({
    method: 'GET',
    path: SOCIAL_START_PAGE,
    operation_id: 'socialStartPage',
    summary: 'Redirect to an upstream sign-in provider',
    tags: ['pages'],
    auth: 'none',
    rate_limit: 'auth_password',
    request: {
      params: z.object({ provider: z.string().max(64) }),
      query: z.object({ return_to: z.string().max(2048).optional() }),
    },
    responses: { 302: { description: 'Redirect to the provider' }, ...htmlResponses },
    handler: async ({ ctx, params, query, request, log, identity }) => {
      if (!socialEnabled(ctx, params.provider)) {
        return page(ctx, {
          status: 403,
          title: 'This sign-in method is turned off',
          body: paragraph('Sign in another way.'),
        });
      }
      const result = await startSocial(
        { ctx, request, log, identity },
        {
          providerId: params.provider,
          intent: 'signin',
          userId: null,
          returnTo: safeReturnTo(query.return_to),
          locale: preferredLocale(request.headers.get('accept-language')) ?? null,
        },
      );
      if (result.status !== 'ok') {
        return page(ctx, {
          status: 403,
          title: 'This sign-in method is turned off',
          body: paragraph('Sign in another way.'),
        });
      }
      return new Response(null, {
        status: 302,
        headers: { ...NO_STORE, [FLOW_BINDING_HEADER]: result.binding, location: result.url },
      });
    },
  });

  router.route({
    method: 'GET',
    path: CONNECT_PAGE,
    operation_id: 'connectSocialPage',
    summary: 'Connect an upstream provider while signed in',
    tags: ['pages'],
    auth: 'session',
    allow_account_states: SIGNED_IN_STATES,
    rate_limit: 'auth_password',
    request: { params: z.object({ provider: z.string().max(64) }) },
    responses: { 302: { description: 'Redirect to the provider' }, ...htmlResponses },
    handler: async ({ ctx, params, identity, request, log }) => {
      if (!socialEnabled(ctx, params.provider)) {
        return page(ctx, {
          status: 403,
          title: 'This sign-in method is turned off',
          body: paragraph('Sign in another way.'),
        });
      }
      const { userId } = sessionUser(identity);
      const result = await startSocial(
        { ctx, request, log, identity },
        {
          providerId: params.provider,
          intent: 'link',
          userId,
          returnTo: IDENTITIES_PAGE,
          locale: preferredLocale(request.headers.get('accept-language')) ?? null,
        },
      );
      if (result.status !== 'ok') {
        return page(ctx, {
          status: 403,
          title: 'This sign-in method is turned off',
          body: paragraph('Sign in another way.'),
        });
      }
      return new Response(null, {
        status: 302,
        headers: { ...NO_STORE, [FLOW_BINDING_HEADER]: result.binding, location: result.url },
      });
    },
  });

  router.route({
    method: 'GET',
    path: SOCIAL_CALLBACK_PAGE,
    operation_id: 'socialCallbackPage',
    summary: 'Finish upstream sign-in after the provider redirects back',
    tags: ['pages'],
    auth: 'none',
    rate_limit: 'auth_verify',
    request: { params: z.object({ provider: z.string().max(64) }) },
    responses: { ...htmlResponses, 303: { description: 'Signed in, going to return_to' } },
    handler: async ({ ctx, params, request, log, identity }) => {
      if (!socialEnabled(ctx, params.provider)) {
        return page(ctx, {
          status: 403,
          title: 'This sign-in method is turned off',
          body: paragraph('Sign in another way.'),
        });
      }
      const url = new URL(request.url);
      const result = await finishSocial(
        { ctx, request, log, identity },
        {
          providerId: params.provider,
          state: url.searchParams.get('state') ?? '',
          code: url.searchParams.get('code') ?? undefined,
          params: url.searchParams,
          error: url.searchParams.get('error') ?? undefined,
        },
      );
      return socialResultPage(ctx, result);
    },
  });

  router.route({
    method: 'GET',
    path: SOCIAL_SIGNUP_PAGE,
    operation_id: 'socialSignupPage',
    summary: 'Enter a date of birth or email after upstream sign-in',
    tags: ['pages'],
    auth: 'none',
    rate_limit: 'global',
    request: {
      query: z.object({
        challenge: z.string().max(256).optional(),
        needs_email: z.string().optional(),
      }),
    },
    responses: htmlResponses,
    handler: ({ ctx, query }) => {
      if (query.challenge === undefined) {
        return Promise.resolve(
          page(ctx, {
            status: 400,
            title: 'Sign in again',
            body: paragraph('This sign-in has expired. Start again from the sign-in page.'),
          }),
        );
      }
      return Promise.resolve(socialSignupForm(ctx, query.challenge, query.needs_email === '1'));
    },
  });

  router.route({
    method: 'POST',
    path: SOCIAL_SIGNUP_PAGE,
    operation_id: 'socialSignupPageSubmit',
    summary: 'Create an account after upstream sign-in',
    tags: ['pages'],
    auth: 'none',
    rate_limit: 'auth_verify',
    responses: { ...htmlResponses, 303: { description: 'Signed in, going to return_to' } },
    handler: async ({ ctx, request, log, identity }) => {
      const form = await readForm(request);
      const challenge = form['challenge'] ?? '';
      const needsEmail = form['needs_email'] === '1';
      const dateOfBirth = form['date_of_birth'] ?? '';
      if (!isValidDateOfBirth(dateOfBirth, new Date())) {
        return socialSignupForm(ctx, challenge, needsEmail, 'Enter your real date of birth.');
      }
      const result = await completeSocialSignup(
        { ctx, request, log, identity },
        { challenge, dateOfBirth, email: form['email'] },
      );
      switch (result.status) {
        case 'invalid':
          return page(ctx, {
            status: 400,
            title: 'Sign in again',
            body: paragraph('This sign-in has expired. Start again from the sign-in page.'),
          });
        case 'account_limit':
          return page(ctx, {
            status: 409,
            title: 'You can’t create another account',
            body: paragraph('This email address already has as many accounts as it can have.'),
          });
        case 'parental_consent_required':
          return page(ctx, {
            status: 403,
            title: 'You can’t create an account yet',
            body: paragraph(
              `People under ${String(ctx.config.parental.consent_age)} need a parent or guardian to approve their account, and that isn’t available yet.`,
            ),
          });
        case 'signed_in':
          return signedIn(ctx, result.session, result.returnTo);
      }
    },
  });

  router.route({
    method: 'GET',
    path: IDENTITIES_PAGE,
    operation_id: 'identitiesPage',
    summary: 'Connected upstream sign-in methods',
    tags: ['pages'],
    auth: 'session',
    allow_account_states: SIGNED_IN_STATES,
    rate_limit: 'global',
    responses: htmlResponses,
    handler: async ({ ctx, identity }) => {
      const { userId } = sessionUser(identity);
      const connected = await listSocialIdentities(ctx.db, userId);
      const available = enabledSocialProviders(ctx.config.features.auth.social);
      const items =
        connected.length === 0
          ? paragraph('No connected sign-in methods yet.')
          : `<ul>${connected
              .map((row) => {
                const name =
                  available.find((provider) => provider.type === row.type)?.name ?? row.type;
                return `<li>${escapeHtml(name)}</li>`;
              })
              .join('')}</ul>`;
      const connect = available
        .filter((provider) => !connected.some((row) => row.type === provider.type))
        .map(
          (provider) =>
            `<p><a href="identities/${encodeURIComponent(provider.id)}/connect">Connect ${escapeHtml(provider.name)}</a></p>`,
        )
        .join('\n');
      return page(ctx, {
        title: 'Connected sign-in methods',
        body: `${items}${connect}`,
      });
    },
  });

  router.route({
    method: 'GET',
    path: CHANGE_EMAIL_PAGE,
    operation_id: 'changeEmailPage',
    summary: 'Page asking to confirm a new email address',
    tags: ['pages'],
    auth: 'none',
    rate_limit: 'global',
    request: { query: z.object({ token: z.string().max(256).optional() }) },
    responses: htmlResponses,
    handler: ({ ctx, query }) => {
      if (query.token === undefined) return Promise.resolve(invalidLink(ctx));
      return Promise.resolve(
        page(ctx, {
          title: 'Confirm your new email',
          body: `<form method="post" action="change-email">
${hiddenInput('token', query.token)}
<p><button type="submit">Continue</button></p>
</form>`,
        }),
      );
    },
  });

  router.route({
    method: 'POST',
    path: CHANGE_EMAIL_PAGE,
    operation_id: 'changeEmailPageSubmit',
    summary: 'Confirm a new email address from the confirmation page',
    tags: ['pages'],
    auth: 'none',
    rate_limit: 'auth_verify',
    responses: htmlResponses,
    handler: async ({ ctx, request, log, identity }) => {
      const token = (await readForm(request))['token'] ?? '';
      const result = await finishEmailChange({ ctx, request, log, identity }, { token });
      if (result.status === 'invalid') return invalidLink(ctx);
      if (result.status === 'account_limit') {
        return page(ctx, {
          status: 409,
          title: 'You can’t use this email address',
          body: paragraph('This email address already has as many accounts as it can have.'),
        });
      }
      return page(ctx, {
        title: 'Email address updated',
        body: paragraph(`This account now uses ${result.email}.`),
      });
    },
  });

  router.route({
    method: 'GET',
    path: REVERT_EMAIL_PAGE,
    operation_id: 'revertEmailPage',
    summary: 'Page asking to undo an email change',
    tags: ['pages'],
    auth: 'none',
    rate_limit: 'global',
    request: { query: z.object({ token: z.string().max(256).optional() }) },
    responses: htmlResponses,
    handler: ({ ctx, query }) => {
      if (query.token === undefined) return Promise.resolve(invalidLink(ctx));
      return Promise.resolve(
        page(ctx, {
          title: 'Undo this email change',
          body: `<form method="post" action="revert-email">
${hiddenInput('token', query.token)}
<p><button type="submit">This wasn’t me</button></p>
</form>`,
        }),
      );
    },
  });

  router.route({
    method: 'POST',
    path: REVERT_EMAIL_PAGE,
    operation_id: 'revertEmailPageSubmit',
    summary: 'Undo an email change from the notice page',
    tags: ['pages'],
    auth: 'none',
    rate_limit: 'auth_verify',
    responses: htmlResponses,
    handler: async ({ ctx, request, log, identity }) => {
      const token = (await readForm(request))['token'] ?? '';
      const result = await finishEmailRevert({ ctx, request, log, identity }, { token });
      if (result.status === 'invalid') return invalidLink(ctx);
      if (result.status === 'account_limit') {
        return page(ctx, {
          status: 409,
          title: 'You can’t use this email address',
          body: paragraph('This email address already has as many accounts as it can have.'),
        });
      }
      return page(ctx, {
        title: 'Email address restored',
        body: paragraph(`This account again uses ${result.email}.`),
      });
    },
  });

  router.route({
    method: 'GET',
    path: BIND_PAGE,
    operation_id: 'bindSession',
    summary: 'Issue a one-time code that binds this session to another surface',
    tags: ['pages'],
    auth: 'session',
    allow_account_states: SIGNED_IN_STATES,
    allow_pending_legal: true,
    allow_pending_parental_consent: true,
    allow_pending_2fa_enrolment: true,
    rate_limit: 'global',
    request: {
      query: z.object({
        target: z.string().max(32).optional(),
        return: z.string().max(2048).optional(),
      }),
    },
    responses: {
      302: { description: 'Redirect to the target surface’s bind callback' },
      ...htmlResponses,
    },
    errors: ['ACCOUNT_NOT_FOUND'],
    handler: async ({ ctx, identity, query, log }) => {
      const { sessionId } = sessionUser(identity);
      const target = parseBindTarget(ctx.config, query.target ?? '', query.return ?? '');
      const store = bindStoreOf(ctx);
      if (target === undefined || store === undefined) return bindFailed(ctx);
      const issued = await issueBindCode(store, {
        sessionId,
        target: target.target,
        origin: target.origin,
        returnPath: target.returnPath,
      });
      const callback = new URL(
        surfacePath(ctx.config, target.target, BIND_CALLBACK_PAGE),
        target.origin,
      );
      callback.searchParams.set('code', issued.code);
      log.info('session bind started', { target: target.target, session_id: sessionId });
      return redirect(callback.toString());
    },
  });

  router.route({
    method: 'GET',
    path: BIND_CALLBACK_PAGE,
    operation_id: 'bindSessionCallback',
    summary: 'Exchange a bind code for a session cookie on this surface',
    tags: ['pages'],
    auth: 'none',
    rate_limit: 'auth_verify',
    request: { query: z.object({ code: z.string().max(256).optional() }) },
    responses: {
      302: { description: 'Signed in on this surface, going to the return path' },
      ...htmlResponses,
    },
    handler: async ({ ctx, query, request, log }) => {
      const store = bindStoreOf(ctx);
      const host = request.headers.get('x-forwarded-host') ?? '';
      const target = surfaceForHost(ctx.config, host);
      const origin = target === undefined ? undefined : surfaceOrigin(ctx.config, target);
      if (
        store === undefined ||
        query.code === undefined ||
        target === undefined ||
        origin === undefined
      ) {
        return bindFailed(ctx);
      }
      const cookieScope = sessionClient(ctx.config, request).cookieScope;
      const result = await completeBind(ctx.db, store, {
        code: query.code,
        target,
        origin,
        cookieScope,
        idleTimeout: ctx.config.cookies.idle_timeout,
        now: new Date(),
      });
      if (result.status !== 'ok') return bindFailed(ctx);
      identityMetrics(ctx.metrics).bindingCreated();
      log.info('session bound', { target, cookie_scope: cookieScope });
      return redirect(
        result.returnPath,
        sessionHeaders({
          token: result.token,
          expiresAt: result.expiresAt,
          evicted: [],
          restored: false,
          id: '',
        }),
      );
    },
  });
}
