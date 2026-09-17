import type { CaptchaWidget } from '@qtiauth/captcha';
import type { Router } from '@qtiauth/service-kit';
import * as z from 'zod';

import { isValidDateOfBirth } from './age.ts';
import {
  type CaptchaCheck,
  captchaFromForm,
  captchaMarkup,
  checkCaptcha,
  noteCaptchaAttempt,
} from './captcha.ts';
import {
  completeEmailVerification,
  completePasswordReset,
  inspectPasswordReset,
  loginPassword,
  magicLinkEnabled,
  passwordEnabled,
  registerWithPassword,
  sendMagicLink,
  sendPasswordReset,
  signup,
  verify,
} from './flows.ts';
import { sessionHeaders } from './headers.ts';
import { escapeHtml, hiddenInput, type HtmlPage, htmlResponse } from './html.ts';
import { preferredLocale } from './locale.ts';
import type { PasswordPolicyReason } from './passwords.ts';
import type { Context } from './service.ts';
import type { CreatedSession } from './sessions.ts';
import {
  accountPath,
  FORGOT_PASSWORD_PAGE,
  LOGIN_PAGE,
  MAGIC_LINK_PAGE,
  MAGIC_LINK_START_PAGE,
  REGISTER_PAGE,
  RESET_PASSWORD_PAGE,
  SIGNUP_CHOICE_PAGE,
  VERIFY_EMAIL_PAGE,
} from './settings.ts';

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
  if (returnTo !== null) {
    return new Response(null, {
      status: 303,
      headers: { ...headers, location: accountPath(ctx.config, returnTo) },
    });
  }
  return page(ctx, {
    title: 'You’re signed in',
    headers,
    body: `<ul>
<li><a href="../api/v1/me">Your account</a></li>
<li><a href="../api/v1/sessions">Your sessions</a></li>
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

function captchaAlert(result: CaptchaCheck): string {
  if (result.status === 'invalid') return 'That CAPTCHA was not completed correctly. Try again.';
  return 'Complete the CAPTCHA to continue.';
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
): Response {
  return page(ctx, {
    status: status ?? (error === undefined ? 200 : 401),
    title: `Sign in to ${ctx.config.branding.product_name}`,
    body: `${error === undefined ? '' : alert(error)}
<form method="post" action="login">
<p><label for="email">Email</label><br>
<input id="email" name="email" type="email" autocomplete="username" required value="${escapeHtml(email)}"></p>
<p><label for="password">Password</label><br>
<input id="password" name="password" type="password" autocomplete="current-password" maxlength="256" required></p>
${captchaBlock(widget)}
<p><button type="submit">Sign in</button></p>
</form>
<p><a href="forgot-password">Forgot password</a></p>`,
  });
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
    handler: async ({ ctx, request, log }) => {
      if (!magicLinkEnabled(ctx)) return disabled(ctx);
      const form = await readForm(request);
      const token = form['token'] ?? '';
      const userId = form['user_id'];
      const result = await verify(
        { ctx, request, log },
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
    summary: 'Choose password or magic-link signup',
    description: 'Interim page until the web app replaces it.',
    tags: ['pages'],
    auth: 'none',
    rate_limit: 'global',
    responses: htmlResponses,
    handler: ({ ctx }) => {
      const password = passwordEnabled(ctx);
      const magic = magicLinkEnabled(ctx);
      if (!password && !magic) {
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
    handler: async ({ ctx, request, log }) => {
      if (!magicLinkEnabled(ctx)) return disabled(ctx);
      const form = await readForm(request);
      const signupToken = form['signup_token'] ?? '';
      const dateOfBirth = form['date_of_birth'] ?? '';
      if (!isValidDateOfBirth(dateOfBirth, new Date())) {
        return dateOfBirthForm(ctx, signupToken, 'Enter your real date of birth.');
      }
      const result = await signup({ ctx, request, log }, { signupToken, dateOfBirth });
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
    handler: async ({ ctx, request, log }) => {
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
        { ctx, request, log },
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
    handler: async ({ ctx, request, log }) => {
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
        { ctx, request, log },
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
    responses: htmlResponses,
    handler: ({ ctx }) => {
      if (!passwordEnabled(ctx)) return Promise.resolve(passwordDisabled(ctx));
      return Promise.resolve(loginForm(ctx, ''));
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
    handler: async ({ ctx, request, log }) => {
      if (!passwordEnabled(ctx)) return passwordDisabled(ctx);
      const form = await readForm(request);
      const email = form['email'] ?? '';
      const password = form['password'] ?? '';
      const captcha = await checkCaptcha(ctx, request, 'password_login', captchaFromForm(form));
      if (captcha.status !== 'ok') {
        return loginForm(ctx, email, captchaAlert(captcha), captcha.widget, 403);
      }
      const result = await loginPassword({ ctx, request, log }, { email, password });
      if (result.status === 'invalid') {
        const next = await checkCaptcha(ctx, request, 'password_login', undefined);
        return loginForm(
          ctx,
          email,
          'Email or password incorrect',
          next.status === 'ok' ? undefined : next.widget,
        );
      }
      return signedIn(ctx, result.session, null);
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
    handler: async ({ ctx, request, log }) => {
      if (!passwordEnabled(ctx)) return passwordDisabled(ctx);
      const email = (await readForm(request))['email'] ?? '';
      if (z.email().safeParse(email).success) {
        await sendPasswordReset({ ctx, request, log }, { email, locale: localeOf(ctx, request) });
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
    handler: async ({ ctx, request, log }) => {
      if (!passwordEnabled(ctx)) return passwordDisabled(ctx);
      const form = await readForm(request);
      const token = form['token'] ?? '';
      const userId = z.uuid().safeParse(form['user_id']).success ? form['user_id'] : undefined;
      const password = form['password'];
      if (password === undefined) {
        const peek = await inspectPasswordReset({ ctx, request, log }, { token, userId });
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
        { ctx, request, log },
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
    handler: async ({ ctx, request, log }) => {
      if (!passwordEnabled(ctx)) return passwordDisabled(ctx);
      const token = (await readForm(request))['token'] ?? '';
      const result = await completeEmailVerification({ ctx, request, log }, { token });
      if (result.status === 'invalid') return invalidLink(ctx);
      return signedIn(ctx, result.session, null);
    },
  });
}
