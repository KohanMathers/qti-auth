import type { CaptchaWidget } from '@qtiauth/captcha';
import { FLOW_BINDING_HEADER, type Router } from '@qtiauth/service-kit';
import * as z from 'zod';

import { findAccount, OPEN_ACCOUNT_STATES, SIGNED_IN_STATES } from './accounts.ts';
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
import type { DataExportStatus } from './database.ts';
import { getExport } from './exports.ts';
import { type SecondFactorMethod, totpEnrolled } from './factors.ts';
import {
  acceptLegal,
  type ChooseUsernameResult,
  chooseUsername,
  completeEmailVerification,
  completePasswordReset,
  completeSocialSignup,
  finishEmailChange,
  finishEmailRevert,
  finishSocial,
  finishTwoFactor,
  grantParentalConsent,
  inspectPasswordReset,
  loginPassword,
  magicLinkEnabled,
  passkeysEnabled,
  passwordEnabled,
  pendingParentalConsent,
  refuseParentalConsent,
  registerWithPassword,
  resendParentalConsent,
  scheduleDeletion,
  sendMagicLink,
  sendPasswordReset,
  signup,
  socialEnabled,
  socialProviderEnabled,
  startDataExport,
  startSocial,
  totpEnabled,
  updateGuardianEmail,
  verify,
} from './flows.ts';
import { NO_STORE, revokedHeaders, sessionHeaders, signedOutHeaders } from './headers.ts';
import { escapeHtml, hiddenInput, type HtmlPage, htmlResponse } from './html.ts';
import {
  currentLegalVersions,
  findCurrentLegalVersion,
  findViewableLegalVersion,
  pendingMaterialVersions,
} from './legal.ts';
import { interpolateLegal, LEGAL_DOCUMENT_ID, LEGAL_VERSION } from './legal-documents.ts';
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
  FAMILY_LEAVE_PAGE,
  FAMILY_PAGE,
  FORGOT_PASSWORD_PAGE,
  GUARDIAN_APPROVE_PAGE,
  GUARDIAN_DECLINE_PAGE,
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
  USERNAME_PAGE,
  DELETE_PAGE,
  EXPORT_PAGE,
  VERIFY_EMAIL_PAGE,
  WAITING_PAGE,
  LEGAL_INDEX_PAGE,
  LEGAL_ACCEPT_PAGE,
  LEGAL_DOCUMENT_PAGE,
  LEGAL_VERSION_PAGE,
} from './settings.ts';
import { listSocialIdentities } from './social.ts';
import { objectStoreOf } from './storage-state.ts';
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

function legalBodyHtml(body: string): string {
  return body
    .split(/\n{2,}/)
    .map((block) => {
      const trimmed = block.trim();
      if (trimmed.startsWith('## ')) {
        return `<h2>${escapeHtml(trimmed.slice(3))}</h2>`;
      }
      if (trimmed.startsWith('# ')) {
        return `<h1>${escapeHtml(trimmed.slice(2))}</h1>`;
      }
      return `<p>${escapeHtml(trimmed).replaceAll('\n', '<br>')}</p>`;
    })
    .join('\n');
}

function legalNotFound(ctx: Context): Response {
  return page(ctx, {
    status: 404,
    title: 'Document not found',
    body: paragraph('That legal document is not available.'),
  });
}

function accountNotFound(ctx: Context): Response {
  return page(ctx, {
    status: 404,
    title: 'Account not found',
    body: paragraph('Sign in again.'),
  });
}

function exportMessage(status: DataExportStatus): string {
  switch (status) {
    case 'ready':
      return 'Your export is ready. Check your email.';
    case 'pending':
      return 'Your export is still being prepared.';
    case 'unavailable':
      return 'This export is too large to email without object storage.';
    case 'failed':
      return 'This export could not be completed.';
  }
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

function dateOfBirthForm(
  ctx: Context,
  signupToken: string,
  values: { guardianEmail?: string | undefined } = {},
  error?: string,
): Response {
  return page(ctx, {
    status: error === undefined ? 200 : 400,
    title: 'Create your account',
    body: `${error === undefined ? '' : alert(error)}
<form method="post" action="signup">
${hiddenInput('signup_token', signupToken)}
<p><label for="date_of_birth">Date of birth</label><br>
<input id="date_of_birth" name="date_of_birth" type="date" required></p>
${guardianEmailField(ctx, values.guardianEmail)}
<p><button type="submit">Create account</button></p>
</form>`,
  });
}

function guardianEmailField(ctx: Context, value = ''): string {
  return `<p>If you are under ${String(ctx.config.parental.consent_age)}, enter a parent or guardian’s email so they can approve your account.</p>
<p><label for="guardian_email">Parent or guardian email</label><br>
<input id="guardian_email" name="guardian_email" type="email" autocomplete="email" value="${escapeHtml(value)}"></p>`;
}

function guardianEmailOf(form: Record<string, string>): string | undefined {
  const value = form['guardian_email']?.trim();
  return value === undefined || value === '' ? undefined : value;
}

function guardianEmailAlert(status: 'guardian_email_required' | 'guardian_email_invalid'): string {
  return status === 'guardian_email_required'
    ? 'Enter a parent or guardian’s email address.'
    : 'Enter a different email address for your parent or guardian.';
}

function waitingForm(
  ctx: Context,
  consent: { guardian_email: string; email_changes_remaining: number; expires_at: string },
  message?: string,
): Response {
  return page(ctx, {
    title: 'Waiting for a parent or guardian',
    body: `${message === undefined ? '' : alert(message)}
${paragraph(`We’ve emailed ${consent.guardian_email}. This account stays limited until they approve it.`)}
${paragraph(`That email can be changed ${String(consent.email_changes_remaining)} more times.`)}
<form method="post" action="waiting">
<p><button type="submit" name="action" value="resend">Send the email again</button></p>
<p><label for="guardian_email">New parent or guardian email</label><br>
<input id="guardian_email" name="guardian_email" type="email" autocomplete="email"></p>
<p><button type="submit" name="action" value="change">Use this address instead</button></p>
</form>
<form method="post" action="../api/v1/auth/logout"><button type="submit">Sign out</button></form>`,
  });
}

async function guardianApproveForm(ctx: Context, token: string, error?: string): Promise<Response> {
  const documents = await currentLegalVersions(ctx.db, new Date());
  const items = documents
    .map(
      (document) =>
        `<li><a href="${escapeHtml(accountPath(ctx.config, `/legal/${document.id}`))}">${escapeHtml(document.id)}</a></li>`,
    )
    .join('');
  return page(ctx, {
    status: error === undefined ? 200 : 400,
    title: 'Approve this account',
    body: `${error === undefined ? '' : alert(error)}
${paragraph('By approving, you confirm you are an adult and accept these documents on the child’s behalf.')}
<ul>${items}</ul>
<form method="post" action="approve">
${hiddenInput('token', token)}
<p><label for="date_of_birth">Your date of birth</label><br>
<input id="date_of_birth" name="date_of_birth" type="date" required></p>
<p><button type="submit">Approve</button></p>
</form>`,
  });
}

async function signedIn(
  ctx: Context,
  session: CreatedSession,
  returnTo: string | null,
  userId: string,
): Promise<Response> {
  const account = await findAccount(ctx.db, userId);
  if (account?.state === 'pending_parental_consent') {
    return new Response(null, {
      status: 303,
      headers: { ...sessionHeaders(session), location: accountPath(ctx.config, WAITING_PAGE) },
    });
  }
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
<li><a href="${escapeHtml(FAMILY_PAGE)}">Family dashboard</a></li>
<li><a href="${escapeHtml(FAMILY_LEAVE_PAGE)}">Parent or guardian link</a></li>
<li><a href="username">Username</a></li>
<li><a href="../api/v1/sessions">Your sessions</a></li>
${passkeysEnabled(ctx) ? '<li><a href="passkeys">Passkeys</a></li>' : ''}
${totpEnabled(ctx) ? '<li><a href="totp">Authenticator app</a></li>' : ''}
${socialEnabled(ctx) ? '<li><a href="identities">Connected sign-in methods</a></li>' : ''}
</ul>
<form method="post" action="../api/v1/auth/logout"><button type="submit">Sign out</button></form>`,
  });
}

function usernameMessage(
  ctx: Context,
  result: Exclude<ChooseUsernameResult, { status: 'saved' } | { status: 'pending' }>,
): string {
  switch (result.status) {
    case 'invalid':
      return `Use ${String(ctx.config.usernames.min_length)}–${String(ctx.config.usernames.max_length)} characters matching ${ctx.config.usernames.charset}.`;
    case 'unavailable':
      return 'Username not available.';
    case 'unchanged':
      return 'That’s already your username.';
    case 'cooldown':
      return `You can change your username again after ${result.availableAt.toISOString().slice(0, 10)}.`;
    case 'limit':
      return 'You have used all your username changes for now.';
    case 'already_pending':
      return 'A username change is already waiting for a parent or guardian.';
    case 'restricted':
      return 'This account cannot change its username right now.';
    case 'not_found':
      return 'Sign in again.';
  }
}

function usernameForm(
  ctx: Context,
  options: { current: string | null; resetRequired: boolean; value?: string; error?: string },
): Response {
  const { current, resetRequired } = options;
  const title = resetRequired || current === null ? 'Choose a username' : 'Change username';
  let prompt = '';
  if (resetRequired) prompt = paragraph('A member of staff asked you to choose a new username.');
  else if (current !== null) prompt = paragraph(`Current username: ${current}`);
  const value = options.value ?? (resetRequired ? '' : (current ?? ''));
  return page(ctx, {
    title,
    body: `${options.error === undefined ? '' : alert(options.error)}
${prompt}
<form method="post" action="username">
<p><label for="username">Username</label><br>
<input id="username" name="username" required minlength="${String(ctx.config.usernames.min_length)}" maxlength="${String(ctx.config.usernames.max_length)}" value="${escapeHtml(value)}"></p>
<p><button type="submit">Save</button></p>
</form>`,
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
  values: { guardianEmail?: string | undefined } = {},
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
${guardianEmailField(ctx, values.guardianEmail)}
<p><button type="submit">Create account</button></p>
</form>`,
  });
}

async function socialResultPage(
  ctx: Context,
  result: Awaited<ReturnType<typeof finishSocial>>,
): Promise<Response> {
  switch (result.status) {
    case 'invalid':
    case 'denied':
    case 'guardian_email_required':
    case 'guardian_email_invalid':
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
    case 'unlink_cooldown':
      return page(ctx, {
        status: 409,
        title: 'Try again later',
        body: paragraph(
          `This Steam account was unlinked recently. It can be linked again after ${result.retryAfter.toISOString()}.`,
        ),
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
      return signedIn(ctx, result.session, result.returnTo, result.userId);
  }
}

function registerForm(
  ctx: Context,
  values: {
    email?: string | undefined;
    dateOfBirth?: string | undefined;
    guardianEmail?: string | undefined;
  },
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
${guardianEmailField(ctx, values.guardianEmail)}
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
          return signedIn(ctx, result.session, result.returnTo, result.userId);
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
        return dateOfBirthForm(
          ctx,
          signupToken,
          { guardianEmail: guardianEmailOf(form) },
          'Enter your real date of birth.',
        );
      }
      const result = await signup(
        { ctx, request, log, identity },
        { signupToken, dateOfBirth, guardianEmail: guardianEmailOf(form) },
      );
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
        case 'guardian_email_required':
        case 'guardian_email_invalid':
          return dateOfBirthForm(
            ctx,
            signupToken,
            { guardianEmail: guardianEmailOf(form) },
            guardianEmailAlert(result.status),
          );
        case 'signed_in':
          return signedIn(ctx, result.session, result.returnTo, result.userId);
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
      const guardianEmail = guardianEmailOf(form);
      if (!z.email().safeParse(email).success) {
        return registerForm(
          ctx,
          { email, dateOfBirth, guardianEmail },
          'Enter a valid email address.',
        );
      }
      if (!isValidDateOfBirth(dateOfBirth, new Date())) {
        return registerForm(
          ctx,
          { email, dateOfBirth, guardianEmail },
          'Enter your real date of birth.',
        );
      }
      const captcha = await checkCaptcha(ctx, request, 'password_signup', captchaFromForm(form));
      if (captcha.status !== 'ok') {
        return registerForm(
          ctx,
          { email, dateOfBirth, guardianEmail },
          captchaAlert(captcha),
          captcha.widget,
        );
      }
      const result = await registerWithPassword(
        { ctx, request, log, identity },
        { email, password, dateOfBirth, guardianEmail, locale: localeOf(ctx, request) },
      );
      await noteCaptchaAttempt(ctx, request, 'password_signup');
      switch (result.status) {
        case 'rejected': {
          const next = await checkCaptcha(ctx, request, 'password_signup', undefined);
          return registerForm(
            ctx,
            { email, dateOfBirth, guardianEmail },
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
        case 'guardian_email_required':
        case 'guardian_email_invalid':
          return registerForm(
            ctx,
            { email, dateOfBirth, guardianEmail },
            guardianEmailAlert(result.status),
          );
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
      return signedIn(ctx, result.session, returnTo, result.userId);
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
            result.userId,
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
      return signedIn(ctx, result.session, null, result.userId);
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
      return signedIn(ctx, result.session, null, result.userId);
    },
  });

  router.route({
    method: 'GET',
    path: TOTP_PAGE,
    operation_id: 'totpPage',
    summary: 'Set up or turn off an authenticator app',
    tags: ['pages'],
    auth: 'session',
    allow_account_states: OPEN_ACCOUNT_STATES,
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
    allow_account_states: OPEN_ACCOUNT_STATES,
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
        if (result.status === 'wrong_code') return totpDisableForm(ctx, 'That code is incorrect.');
        if (result.status === 'not_enabled') return totpStartForm(ctx);
        return page(ctx, {
          title: 'Authenticator app is off',
          headers: revokedHeaders([sessionId]),
          body: paragraph('You can set it up again at any time.'),
        });
      }
      const account = await findAccount(ctx.db, userId);
      if (!account) return accountNotFound(ctx);
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
    allow_account_states: OPEN_ACCOUNT_STATES,
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
    path: USERNAME_PAGE,
    operation_id: 'usernamePage',
    summary: 'Claim or change this account’s username',
    tags: ['pages'],
    auth: 'session',
    allow_account_states: OPEN_ACCOUNT_STATES,
    rate_limit: 'global',
    responses: htmlResponses,
    handler: async ({ ctx, identity }) => {
      const { userId } = sessionUser(identity);
      const account = await findAccount(ctx.db, userId);
      if (!account) return accountNotFound(ctx);
      return usernameForm(ctx, {
        current: account.username,
        resetRequired: account.username_reset_required,
      });
    },
  });

  router.route({
    method: 'POST',
    path: USERNAME_PAGE,
    operation_id: 'usernamePageSubmit',
    summary: 'Save a username from the username page',
    tags: ['pages'],
    auth: 'session',
    allow_account_states: OPEN_ACCOUNT_STATES,
    rate_limit: 'global',
    responses: htmlResponses,
    handler: async ({ ctx, identity, request, log }) => {
      const { userId } = sessionUser(identity);
      const account = await findAccount(ctx.db, userId);
      if (!account) return accountNotFound(ctx);
      const form = await readForm(request);
      const username = form['username'] ?? '';
      const result = await chooseUsername({ ctx, request, log }, { userId, username });
      if (result.status === 'pending') {
        return page(ctx, {
          title: 'Waiting for approval',
          body: paragraph('A parent or guardian needs to approve this username.'),
        });
      }
      if (result.status !== 'saved') {
        return usernameForm(ctx, {
          current: account.username,
          resetRequired: account.username_reset_required,
          value: username,
          error: usernameMessage(ctx, result),
        });
      }
      return page(ctx, {
        title: 'Username saved',
        body: `${paragraph(`Your username is ${result.username}.`)}
<p><a href="../api/v1/me">Your account</a></p>`,
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
      if (!socialProviderEnabled(ctx, params.provider)) {
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
    allow_account_states: OPEN_ACCOUNT_STATES,
    rate_limit: 'auth_password',
    request: { params: z.object({ provider: z.string().max(64) }) },
    responses: { 302: { description: 'Redirect to the provider' }, ...htmlResponses },
    handler: async ({ ctx, params, identity, request, log }) => {
      if (!socialProviderEnabled(ctx, params.provider)) {
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
      if (!socialProviderEnabled(ctx, params.provider)) {
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
      const guardianEmail = guardianEmailOf(form);
      if (!isValidDateOfBirth(dateOfBirth, new Date())) {
        return socialSignupForm(
          ctx,
          challenge,
          needsEmail,
          { guardianEmail },
          'Enter your real date of birth.',
        );
      }
      const result = await completeSocialSignup(
        { ctx, request, log, identity },
        { challenge, dateOfBirth, email: form['email'], guardianEmail },
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
        case 'guardian_email_required':
        case 'guardian_email_invalid':
          return socialSignupForm(
            ctx,
            challenge,
            needsEmail,
            { guardianEmail },
            guardianEmailAlert(result.status),
          );
        case 'signed_in':
          return signedIn(ctx, result.session, result.returnTo, result.userId);
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
    allow_account_states: OPEN_ACCOUNT_STATES,
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
    allow_account_states: OPEN_ACCOUNT_STATES,
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
          id: result.sessionId,
          token: result.token,
          expiresAt: result.expiresAt,
          evicted: [],
        }),
      );
    },
  });

  router.route({
    method: 'GET',
    path: LEGAL_INDEX_PAGE,
    operation_id: 'legalIndexPage',
    summary: 'Current legal documents',
    tags: ['pages'],
    auth: 'none',
    rate_limit: 'global',
    responses: htmlResponses,
    handler: async ({ ctx }) => {
      const documents = await currentLegalVersions(ctx.db, new Date());
      const items = documents
        .map((document) => {
          const summary = interpolateLegal(document.summary, ctx.config.branding);
          return `<li><a href="${escapeHtml(accountPath(ctx.config, `/legal/${document.id}`))}">${escapeHtml(document.id)}</a> — ${escapeHtml(summary)}</li>`;
        })
        .join('\n');
      return page(ctx, {
        title: 'Legal documents',
        body:
          documents.length === 0
            ? paragraph('No legal documents are published.')
            : `<ul>${items}</ul>`,
      });
    },
  });

  router.route({
    method: 'GET',
    path: LEGAL_ACCEPT_PAGE,
    operation_id: 'legalAcceptPage',
    summary: 'Accept updated legal documents',
    tags: ['pages'],
    auth: 'session',
    allow_account_states: OPEN_ACCOUNT_STATES,
    allow_pending_legal: true,
    allow_pending_parental_consent: true,
    rate_limit: 'global',
    responses: htmlResponses,
    handler: async ({ ctx, identity }) => {
      const { userId } = sessionUser(identity);
      const pending = await pendingMaterialVersions(ctx.db, userId, new Date());
      if (pending.length === 0) {
        return page(ctx, {
          title: 'Legal documents',
          body: paragraph('There is nothing you need to accept right now.'),
        });
      }
      const items = pending
        .map(
          (document) =>
            `<li><a href="${escapeHtml(accountPath(ctx.config, `/legal/${document.id}/${document.version}`))}">${escapeHtml(document.id)}</a> — ${escapeHtml(interpolateLegal(document.summary, ctx.config.branding))}</li>`,
        )
        .join('\n');
      return page(ctx, {
        title: 'Please accept these documents',
        body: `<ul>${items}</ul>
<form method="post" action="accept">
<p><button type="submit">Accept</button></p>
</form>`,
      });
    },
  });

  router.route({
    method: 'POST',
    path: LEGAL_ACCEPT_PAGE,
    operation_id: 'legalAcceptPageSubmit',
    summary: 'Accept updated legal documents from the form',
    tags: ['pages'],
    auth: 'session',
    allow_account_states: OPEN_ACCOUNT_STATES,
    allow_pending_legal: true,
    allow_pending_parental_consent: true,
    rate_limit: 'global',
    responses: htmlResponses,
    handler: async ({ ctx, identity, request, log }) => {
      const { userId } = sessionUser(identity);
      const pending = await pendingMaterialVersions(ctx.db, userId, new Date());
      await acceptLegal(
        { ctx, request, log },
        {
          userId,
          documents: pending.map((document) => ({ id: document.id, version: document.version })),
        },
      );
      const remaining = await pendingMaterialVersions(ctx.db, userId, new Date());
      if (remaining.length > 0) {
        return page(ctx, {
          title: 'Please accept these documents',
          body:
            paragraph('Some documents still need to be accepted.') +
            paragraph('Open the legal documents page to continue.'),
        });
      }
      return page(ctx, {
        title: 'Thank you',
        body: paragraph('You have accepted the updated documents.'),
      });
    },
  });

  router.route({
    method: 'GET',
    path: LEGAL_DOCUMENT_PAGE,
    operation_id: 'legalDocumentPage',
    summary: 'The currently effective version of a legal document',
    tags: ['pages'],
    auth: 'none',
    rate_limit: 'global',
    request: { params: z.object({ id: z.string().regex(LEGAL_DOCUMENT_ID) }) },
    responses: htmlResponses,
    handler: async ({ ctx, params }) => {
      const document = await findCurrentLegalVersion(ctx.db, params.id, new Date());
      if (!document) return legalNotFound(ctx);
      const brand = ctx.config.branding;
      return page(ctx, {
        title: interpolateLegal(document.summary, brand),
        body: legalBodyHtml(interpolateLegal(document.body, brand)),
      });
    },
  });

  router.route({
    method: 'GET',
    path: LEGAL_VERSION_PAGE,
    operation_id: 'legalVersionPage',
    summary: 'A specific version of a legal document',
    tags: ['pages'],
    auth: 'none',
    rate_limit: 'global',
    request: {
      params: z.object({
        id: z.string().regex(LEGAL_DOCUMENT_ID),
        version: z.string().regex(LEGAL_VERSION),
      }),
    },
    responses: htmlResponses,
    handler: async ({ ctx, params }) => {
      const document = await findViewableLegalVersion(ctx.db, {
        id: params.id,
        version: params.version,
        publicHistory: ctx.config.legal.public_history,
        now: new Date(),
      });
      if (!document) return legalNotFound(ctx);
      const brand = ctx.config.branding;
      return page(ctx, {
        title: interpolateLegal(document.summary, brand),
        body: legalBodyHtml(interpolateLegal(document.body, brand)),
      });
    },
  });

  router.route({
    method: 'GET',
    path: DELETE_PAGE,
    operation_id: 'deleteAccountPage',
    summary: 'Ask to delete this account',
    tags: ['pages'],
    auth: 'session',
    step_up: true,
    allow_account_states: SIGNED_IN_STATES,
    rate_limit: 'global',
    responses: htmlResponses,
    handler: async ({ ctx, identity }) => {
      const { userId } = sessionUser(identity);
      const account = await findAccount(ctx.db, userId);
      if (!account) return accountNotFound(ctx);
      if (account.state === 'pending_deletion') {
        return page(ctx, {
          title: 'Deletion already scheduled',
          body: paragraph('This account will be deleted unless you sign in again.'),
        });
      }
      return page(ctx, {
        title: 'Delete your account',
        body: `${paragraph('This signs you out everywhere. You can cancel by signing in again during the waiting period.')}
<form method="post" action="delete">
<p><button type="submit">Delete my account</button></p>
</form>`,
      });
    },
  });

  router.route({
    method: 'POST',
    path: DELETE_PAGE,
    operation_id: 'deleteAccountPageSubmit',
    summary: 'Schedule account deletion from the form',
    tags: ['pages'],
    auth: 'session',
    step_up: true,
    allow_account_states: SIGNED_IN_STATES,
    rate_limit: 'global',
    responses: htmlResponses,
    handler: async ({ ctx, identity, request, log }) => {
      const { userId } = sessionUser(identity);
      const result = await scheduleDeletion({ ctx, request, log }, { userId });
      if (result.status === 'not_found') return accountNotFound(ctx);
      if (result.status === 'conflict') {
        return page(ctx, {
          status: 409,
          title: 'This account cannot be deleted',
          body: paragraph('The account is not in a state that allows deletion.'),
        });
      }
      return page(ctx, {
        title: 'Your account will be deleted',
        headers: signedOutHeaders(result.revoked),
        body: paragraph('You have been signed out. Sign in again if you change your mind.'),
      });
    },
  });

  router.route({
    method: 'GET',
    path: EXPORT_PAGE,
    operation_id: 'exportAccountPage',
    summary: 'Request a copy of this account’s data',
    tags: ['pages'],
    auth: 'session',
    step_up: true,
    allow_account_states: SIGNED_IN_STATES,
    rate_limit: 'global',
    request: { query: z.object({ id: z.uuid().optional() }) },
    responses: htmlResponses,
    handler: async ({ ctx, identity, query }) => {
      const { userId } = sessionUser(identity);
      if (query.id !== undefined) {
        const exported = await getExport(ctx.db, {
          userId,
          exportId: query.id,
          store: objectStoreOf(ctx),
          now: new Date(),
        });
        if (!exported) {
          return page(ctx, {
            status: 404,
            title: 'Export not found',
            body: paragraph('That export is unknown.'),
          });
        }
        return page(ctx, { title: 'Data export', body: paragraph(exportMessage(exported.status)) });
      }
      return page(ctx, {
        title: 'Download your data',
        body: `${paragraph('We will email you a copy of the data this service holds about you.')}
<form method="post" action="export">
<p><button type="submit">Request an export</button></p>
</form>`,
      });
    },
  });

  router.route({
    method: 'POST',
    path: EXPORT_PAGE,
    operation_id: 'exportAccountPageSubmit',
    summary: 'Start a data export from the form',
    tags: ['pages'],
    auth: 'session',
    step_up: true,
    allow_account_states: SIGNED_IN_STATES,
    rate_limit: 'global',
    responses: htmlResponses,
    handler: async ({ ctx, identity, request, log }) => {
      const { userId } = sessionUser(identity);
      const result = await startDataExport({ ctx, request, log }, { userId });
      if (result.status === 'not_found') return accountNotFound(ctx);
      return page(ctx, {
        status: 202,
        title: 'Export started',
        body: `${paragraph('We will email you when it is ready.')}
<p><a href="export?id=${escapeHtml(result.id)}">Check status</a></p>`,
      });
    },
  });

  router.route({
    method: 'GET',
    path: WAITING_PAGE,
    operation_id: 'waitingPage',
    summary: 'Waiting for a parent or guardian to approve the account',
    tags: ['pages'],
    auth: 'session',
    allow_account_states: ['pending_parental_consent'],
    allow_pending_parental_consent: true,
    rate_limit: 'global',
    responses: htmlResponses,
    handler: async ({ ctx, identity }) => {
      const { userId } = sessionUser(identity);
      const consent = await pendingParentalConsent(ctx, userId);
      if (consent === null) return accountNotFound(ctx);
      return waitingForm(ctx, consent);
    },
  });

  router.route({
    method: 'POST',
    path: WAITING_PAGE,
    operation_id: 'waitingPageSubmit',
    summary: 'Resend or change the parent or guardian email',
    tags: ['pages'],
    auth: 'session',
    allow_account_states: ['pending_parental_consent'],
    allow_pending_parental_consent: true,
    rate_limit: 'magic_link',
    responses: htmlResponses,
    handler: async ({ ctx, identity, request, log }) => {
      const { userId } = sessionUser(identity);
      const form = await readForm(request);
      if (form['action'] === 'change') {
        const email = guardianEmailOf(form) ?? '';
        const result = await updateGuardianEmail(
          { ctx, request, log, identity },
          { userId, email },
        );
        const consent = await pendingParentalConsent(ctx, userId);
        if (consent === null) return accountNotFound(ctx);
        switch (result.status) {
          case 'ok':
            return waitingForm(ctx, consent, 'We’ve emailed the new address.');
          case 'unchanged':
            return waitingForm(ctx, consent, 'That is already the parent or guardian email.');
          case 'limit':
            return waitingForm(ctx, consent, 'This email cannot be changed again.');
          case 'invalid':
            return waitingForm(ctx, consent, guardianEmailAlert('guardian_email_invalid'));
          case 'not_pending':
            return accountNotFound(ctx);
        }
      }
      const result = await resendParentalConsent({ ctx, request, log, identity }, { userId });
      const consent = await pendingParentalConsent(ctx, userId);
      if (result.status !== 'ok' || consent === null) return accountNotFound(ctx);
      return waitingForm(ctx, consent, 'We’ve sent the email again.');
    },
  });

  router.route({
    method: 'GET',
    path: GUARDIAN_APPROVE_PAGE,
    operation_id: 'guardianApprovePage',
    summary: 'Ask a parent or guardian to approve a child account',
    tags: ['pages'],
    auth: 'none',
    rate_limit: 'global',
    request: { query: z.object({ token: z.string().max(256).optional() }) },
    responses: htmlResponses,
    handler: async ({ ctx, query }) => {
      if (query.token === undefined) return invalidLink(ctx);
      return guardianApproveForm(ctx, query.token);
    },
  });

  router.route({
    method: 'POST',
    path: GUARDIAN_APPROVE_PAGE,
    operation_id: 'guardianApprovePageSubmit',
    summary: 'Approve a child account from the emailed link',
    tags: ['pages'],
    auth: 'none',
    rate_limit: 'auth_verify',
    responses: htmlResponses,
    handler: async ({ ctx, request, log, identity }) => {
      const form = await readForm(request);
      const token = form['token'] ?? '';
      const dateOfBirth = form['date_of_birth'] ?? '';
      if (!isValidDateOfBirth(dateOfBirth, new Date())) {
        return guardianApproveForm(ctx, token, 'Enter your real date of birth.');
      }
      const result = await grantParentalConsent(
        { ctx, request, log, identity },
        { token, dateOfBirth },
      );
      if (result.status === 'not_adult') {
        return guardianApproveForm(
          ctx,
          token,
          `You need to be at least ${String(ctx.config.age.bands.adult)} to approve this account.`,
        );
      }
      if (result.status !== 'ok') return invalidLink(ctx);
      return page(ctx, {
        title: 'Account approved',
        body: paragraph('The account is ready to use.'),
      });
    },
  });

  router.route({
    method: 'GET',
    path: GUARDIAN_DECLINE_PAGE,
    operation_id: 'guardianDeclinePage',
    summary: 'Ask a parent or guardian to decline a child account',
    tags: ['pages'],
    auth: 'none',
    rate_limit: 'global',
    request: { query: z.object({ token: z.string().max(256).optional() }) },
    responses: htmlResponses,
    handler: ({ ctx, query }) => {
      if (query.token === undefined) return Promise.resolve(invalidLink(ctx));
      return Promise.resolve(
        page(ctx, {
          title: 'Decline this account',
          body: `<form method="post" action="decline">
${hiddenInput('token', query.token)}
<p><button type="submit">Decline and delete the account</button></p>
</form>`,
        }),
      );
    },
  });

  router.route({
    method: 'POST',
    path: GUARDIAN_DECLINE_PAGE,
    operation_id: 'guardianDeclinePageSubmit',
    summary: 'Decline a child account from the emailed link',
    tags: ['pages'],
    auth: 'none',
    rate_limit: 'auth_verify',
    responses: htmlResponses,
    handler: async ({ ctx, request, log, identity }) => {
      const token = (await readForm(request))['token'] ?? '';
      const result = await refuseParentalConsent({ ctx, request, log, identity }, { token });
      if (result.status !== 'ok') return invalidLink(ctx);
      return page(ctx, {
        title: 'Account declined',
        body: paragraph('The account has been deleted.'),
      });
    },
  });
}
