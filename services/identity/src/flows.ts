import { queueEmail } from '@qtiauth/email';
import type { Logger } from '@qtiauth/observability';
import { FLOW_BINDING_HEADER } from '@qtiauth/service-kit';

import { dateOfBirthColumn } from './accounts.ts';
import { ageOn, under18 } from './age.ts';
import { confirmEmailChange, revertEmailChange, startEmailChange } from './email-change.ts';
import {
  completeSignup,
  issueMagicLink,
  MAGIC_LINK_METHOD,
  type SignupResult,
  verifyMagicLink,
  type VerifyResult,
} from './magic-links.ts';
import { identityMetrics } from './metrics.ts';
import { oauthStoreOf, type SocialIntent } from './oauth-state.ts';
import {
  completePasswordSignup,
  consumePasswordReset,
  type ConsumeResetResult,
  type EmailVerifyResult,
  issueEmailVerification,
  issuePasswordReset,
  loginWithPassword,
  type PasswordLoginResult,
  type PasswordResetResult,
  type PasswordSignupResult,
  resetPassword,
  setAccountPassword,
  type SetPasswordResult,
  verifyEmailAddress,
} from './password-auth.ts';
import { PASSWORD_METHOD } from './passwords.ts';
import { anySocialEnabled, findSocialProvider, metricMethod } from './providers.ts';
import type { Context } from './service.ts';
import {
  accountOrigin,
  CHANGE_EMAIL_PAGE,
  clientFor,
  clientIp,
  emailChangeSettings,
  emailLinkUrl,
  encryptionKey,
  magicLinkSettings,
  magicLinkUrl,
  passwordSettings,
  RESET_PASSWORD_PAGE,
  REVERT_EMAIL_PAGE,
  sessionSettings,
  socialCallbackUrl,
  socialSettings,
  VERIFY_EMAIL_PAGE,
} from './settings.ts';
import type { CreatedSession } from './sessions.ts';
import {
  beginSocial,
  completeSocial,
  type CompleteSocialResult,
  finishSocialSignup,
} from './social.ts';
import { completeSecondFactor } from './two-factor.ts';

export interface FlowInput {
  ctx: Context;
  request: Request;
  log: Logger;
  identity?: { sid: string | null } | null;
}

function expiresInMinutes(ms: number): number {
  return Math.max(1, Math.ceil(ms / 60_000));
}

export async function notifyNewDevice(ctx: Context, session: CreatedSession): Promise<void> {
  const notice = session.newDevice;
  if (notice === null) return;
  if (!ctx.config.session_security.new_device_email) {
    const row = await ctx.db
      .selectFrom('sessions')
      .innerJoin('users', 'users.id', 'sessions.user_id')
      .select(dateOfBirthColumn.as('date_of_birth'))
      .where('sessions.id', '=', session.id)
      .executeTakeFirst();
    if (!row) return;
    if (!under18(ageOn(row.date_of_birth, new Date()), ctx.config.age.bands)) return;
  }
  await queueEmail(ctx.bus, {
    template: 'new_device',
    to: { address: notice.email },
    locale: notice.locale ?? ctx.config.email.default_locale,
    variables: {
      browser: notice.browser,
      os: notice.os,
      place: notice.place,
    },
  });
  await ctx.db
    .updateTable('session_security_events')
    .set({ notified: true })
    .where('session_id', '=', session.id)
    .where('kind', '=', 'new_device')
    .execute();
}

/** Counts a new session and sends the new-device notice, for every sign-in path. */
export async function trackSession(
  ctx: Context,
  method: string,
  session: CreatedSession,
): Promise<void> {
  if (!session.restored)
    identityMetrics(ctx.metrics).sessionCreated(method, session.evicted.length);
  await notifyNewDevice(ctx, session);
}

export function magicLinkEnabled(ctx: Context): boolean {
  return ctx.config.features.auth.magic_link.enabled;
}

export function passwordEnabled(ctx: Context): boolean {
  return ctx.config.features.auth.password.enabled;
}

export function passkeysEnabled(ctx: Context): boolean {
  return ctx.config.features.auth.passkeys.enabled;
}

export function totpEnabled(ctx: Context): boolean {
  return ctx.config.features.auth.totp.enabled;
}

export async function sendMagicLink(
  { ctx, log }: FlowInput,
  input: { email: string; locale: string; returnTo: string | null },
): Promise<void> {
  const { token, expiresAt } = await issueMagicLink(ctx.db, {
    email: input.email,
    locale: input.locale,
    returnTo: input.returnTo,
    settings: magicLinkSettings(ctx.config),
    now: new Date(),
  });
  const job = await queueEmail(ctx.bus, {
    template: 'magic_link',
    to: { address: input.email.trim() },
    locale: input.locale,
    variables: {
      link: magicLinkUrl(ctx.config, token),
      expires_in_minutes: expiresInMinutes(ctx.config.magic_link.ttl),
    },
  });
  identityMetrics(ctx.metrics).magicLink('sent');
  log.info('magic link sent', {
    delivery_id: job.delivery_id,
    expires_at: expiresAt.toISOString(),
  });
}

export async function verify(
  { ctx, request, log, identity }: FlowInput,
  input: { token: string; userId: string | undefined },
): Promise<VerifyResult> {
  const metrics = identityMetrics(ctx.metrics);
  const result = await verifyMagicLink(ctx.db, {
    token: input.token,
    userId: input.userId,
    client: clientFor(ctx, request, identity),
    settings: magicLinkSettings(ctx.config),
    now: new Date(),
  });
  switch (result.status) {
    case 'invalid':
      metrics.magicLink(result.reason === 'expired' ? 'expired' : 'invalid');
      metrics.signIn(MAGIC_LINK_METHOD, 'failure');
      log.info('magic link rejected', { reason: result.reason });
      break;
    case 'choose_account':
      log.info('magic link matches several accounts', { accounts: result.accounts.length });
      break;
    case 'signup_required':
      metrics.magicLink('used');
      log.info('magic link opened for a new account');
      break;
    case 'signed_in':
      ctx.outbox.wake();
      metrics.magicLink('used');
      metrics.signIn(MAGIC_LINK_METHOD, 'success');
      await trackSession(ctx, MAGIC_LINK_METHOD, result.session);
      log.info('signed in', {
        method: MAGIC_LINK_METHOD,
        user_id: result.userId,
        session_id: result.session.id,
        evicted_sessions: result.session.evicted.length,
      });
      break;
  }
  return result;
}

export async function signup(
  { ctx, request, log, identity }: FlowInput,
  input: { signupToken: string; dateOfBirth: string },
): Promise<SignupResult> {
  const metrics = identityMetrics(ctx.metrics);
  const result = await completeSignup(ctx.db, {
    signupToken: input.signupToken,
    dateOfBirth: input.dateOfBirth,
    client: clientFor(ctx, request, identity),
    settings: magicLinkSettings(ctx.config),
    now: new Date(),
  });
  switch (result.status) {
    case 'invalid':
      log.info('signup token rejected', { reason: result.reason });
      break;
    case 'account_limit':
      log.info('signup refused: too many accounts with this email address');
      break;
    case 'parental_consent_required':
      log.info('signup refused: parental consent is not available');
      break;
    case 'signed_in':
      ctx.outbox.wake();
      metrics.signup(MAGIC_LINK_METHOD, result.ageBand);
      await trackSession(ctx, MAGIC_LINK_METHOD, result.session);
      log.info('account created', {
        method: MAGIC_LINK_METHOD,
        user_id: result.userId,
        session_id: result.session.id,
        age_band: result.ageBand,
      });
      break;
  }
  return result;
}

export async function registerWithPassword(
  { ctx, log }: FlowInput,
  input: { email: string; password: string; dateOfBirth: string; locale: string },
): Promise<PasswordSignupResult> {
  const metrics = identityMetrics(ctx.metrics);
  const result = await completePasswordSignup(ctx.db, {
    email: input.email,
    password: input.password,
    dateOfBirth: input.dateOfBirth,
    locale: input.locale,
    settings: passwordSettings(ctx.config),
    now: new Date(),
  });
  switch (result.status) {
    case 'rejected':
      if (result.reason === 'breached') metrics.breachCheck('rejected');
      log.info('password rejected', { reason: result.reason });
      break;
    case 'account_limit':
      log.info('signup refused: too many accounts with this email address');
      break;
    case 'parental_consent_required':
      log.info('signup refused: parental consent is not available');
      break;
    case 'created': {
      ctx.outbox.wake();
      metrics.signup(PASSWORD_METHOD, result.ageBand);
      const job = await queueEmail(ctx.bus, {
        template: 'email_verification',
        to: { address: input.email.trim() },
        locale: input.locale,
        userId: result.userId,
        variables: {
          link: emailLinkUrl(ctx.config, VERIFY_EMAIL_PAGE, result.verifyToken),
          expires_in_minutes: expiresInMinutes(ctx.config.password.verification_ttl),
        },
      });
      log.info('account created', {
        method: PASSWORD_METHOD,
        user_id: result.userId,
        age_band: result.ageBand,
        delivery_id: job.delivery_id,
        expires_at: result.expiresAt.toISOString(),
      });
      break;
    }
  }
  return result;
}

export async function loginPassword(
  { ctx, request, log, identity }: FlowInput,
  input: { email: string; password: string },
): Promise<PasswordLoginResult> {
  const metrics = identityMetrics(ctx.metrics);
  const result = await loginWithPassword(ctx.db, {
    email: input.email,
    password: input.password,
    ip: clientIp(request),
    client: clientFor(ctx, request, identity),
    settings: passwordSettings(ctx.config),
    now: new Date(),
  });
  switch (result.status) {
    case 'invalid':
      metrics.signIn(PASSWORD_METHOD, 'failure');
      metrics.passwordFailure();
      log.info('password sign-in failed', { method: PASSWORD_METHOD });
      break;
    case 'second_factor_required':
      log.info('password sign-in needs a second factor', { user_id: result.userId });
      break;
    case 'signed_in':
      ctx.outbox.wake();
      metrics.signIn(PASSWORD_METHOD, 'success');
      await trackSession(ctx, PASSWORD_METHOD, result.session);
      log.info('signed in', {
        method: PASSWORD_METHOD,
        user_id: result.userId,
        session_id: result.session.id,
        evicted_sessions: result.session.evicted.length,
      });
      break;
  }
  return result;
}

export async function sendPasswordReset(
  { ctx, log }: FlowInput,
  input: { email: string; locale: string },
): Promise<void> {
  const { token, expiresAt } = await issuePasswordReset(ctx.db, {
    email: input.email,
    locale: input.locale,
    settings: passwordSettings(ctx.config),
    now: new Date(),
  });
  const job = await queueEmail(ctx.bus, {
    template: 'password_reset',
    to: { address: input.email.trim() },
    locale: input.locale,
    variables: {
      link: emailLinkUrl(ctx.config, RESET_PASSWORD_PAGE, token),
      expires_in_minutes: expiresInMinutes(ctx.config.password.reset_ttl),
    },
  });
  log.info('password reset sent', {
    delivery_id: job.delivery_id,
    expires_at: expiresAt.toISOString(),
  });
}

export async function inspectPasswordReset(
  { ctx }: FlowInput,
  input: { token: string; userId: string | undefined },
): Promise<ConsumeResetResult> {
  return consumePasswordReset(ctx.db, {
    token: input.token,
    userId: input.userId,
    settings: passwordSettings(ctx.config),
    now: new Date(),
  });
}

export async function completePasswordReset(
  { ctx, request, log, identity }: FlowInput,
  input: {
    token: string;
    password: string;
    keepOtherSessions: boolean;
    userId: string | undefined;
  },
): Promise<PasswordResetResult> {
  const metrics = identityMetrics(ctx.metrics);
  const result = await resetPassword(ctx.db, {
    token: input.token,
    password: input.password,
    keepOtherSessions: input.keepOtherSessions,
    userId: input.userId,
    client: clientFor(ctx, request, identity),
    settings: passwordSettings(ctx.config),
    now: new Date(),
  });
  switch (result.status) {
    case 'invalid':
      log.info('password reset rejected', { reason: result.reason });
      break;
    case 'choose_account':
      log.info('password reset matches several accounts', { accounts: result.accounts.length });
      break;
    case 'rejected':
      if (result.reason === 'breached') metrics.breachCheck('rejected');
      log.info('password rejected', { reason: result.reason });
      break;
    case 'signed_in':
      ctx.outbox.wake();
      metrics.signIn(PASSWORD_METHOD, 'success');
      await trackSession(ctx, PASSWORD_METHOD, result.session);
      if (result.revoked.length > 0) metrics.sessionsRevoked('revoked', result.revoked.length);
      log.info('password reset', {
        user_id: result.userId,
        session_id: result.session.id,
        revoked_sessions: result.revoked.length,
      });
      break;
  }
  return result;
}

export async function sendEmailVerification(
  { ctx, log }: FlowInput,
  input: { email: string; locale: string },
): Promise<void> {
  const issued = await issueEmailVerification(ctx.db, {
    email: input.email,
    locale: input.locale,
    settings: passwordSettings(ctx.config),
    now: new Date(),
  });
  if (!issued.sent || issued.token === undefined || issued.expiresAt === undefined) {
    log.info('email verification not sent');
    return;
  }
  const job = await queueEmail(ctx.bus, {
    template: 'email_verification',
    to: { address: input.email.trim() },
    locale: input.locale,
    variables: {
      link: emailLinkUrl(ctx.config, VERIFY_EMAIL_PAGE, issued.token),
      expires_in_minutes: expiresInMinutes(ctx.config.password.verification_ttl),
    },
  });
  log.info('email verification sent', {
    delivery_id: job.delivery_id,
    expires_at: issued.expiresAt.toISOString(),
  });
}

export async function completeEmailVerification(
  { ctx, request, log, identity }: FlowInput,
  input: { token: string },
): Promise<EmailVerifyResult> {
  const result = await verifyEmailAddress(ctx.db, {
    token: input.token,
    client: clientFor(ctx, request, identity),
    settings: passwordSettings(ctx.config),
    now: new Date(),
  });
  switch (result.status) {
    case 'invalid':
      log.info('email verification rejected', { reason: result.reason });
      break;
    case 'signed_in':
      ctx.outbox.wake();
      await trackSession(ctx, PASSWORD_METHOD, result.session);
      log.info('email verified', { user_id: result.userId, session_id: result.session.id });
      break;
  }
  return result;
}

export async function updatePassword(
  { ctx, log }: FlowInput,
  input: {
    userId: string;
    sessionId: string;
    password: string;
    currentPassword: string | undefined;
  },
): Promise<SetPasswordResult> {
  const metrics = identityMetrics(ctx.metrics);
  const result = await setAccountPassword(ctx.db, {
    userId: input.userId,
    sessionId: input.sessionId,
    password: input.password,
    currentPassword: input.currentPassword,
    settings: passwordSettings(ctx.config),
    now: new Date(),
  });
  switch (result.status) {
    case 'rejected':
      if (result.reason === 'breached') metrics.breachCheck('rejected');
      log.info('password rejected', { reason: result.reason });
      break;
    case 'current_required':
    case 'current_incorrect':
    case 'step_up_required':
    case 'not_found':
      log.info('password change refused', { reason: result.status });
      break;
    case 'updated':
      ctx.outbox.wake();
      log.info(result.added ? 'password added' : 'password changed', { user_id: input.userId });
      break;
  }
  return result;
}

export async function finishTwoFactor(
  { ctx, request, log, identity }: FlowInput,
  input: { challenge: string; totp?: string | undefined; recoveryCode?: string | undefined },
): Promise<Awaited<ReturnType<typeof completeSecondFactor>>> {
  const metrics = identityMetrics(ctx.metrics);
  const factor = input.totp !== undefined ? 'totp' : 'recovery';
  const result = await completeSecondFactor(ctx.db, {
    challenge: input.challenge,
    totp: input.totp,
    recoveryCode: input.recoveryCode,
    key: encryptionKey(ctx.config),
    client: clientFor(ctx, request, identity),
    sessions: sessionSettings(ctx.config),
    now: new Date(),
  });
  if (result.status === 'invalid' || result.status === 'wrong_code') {
    metrics.twoFactor(factor, 'failure');
    log.info('second factor failed', { reason: result.status });
    return result;
  }
  ctx.outbox.wake();
  metrics.twoFactor(result.method, 'success');
  metrics.signIn(result.authMethod, 'success');
  await trackSession(ctx, result.authMethod, result.session);
  log.info('signed in', {
    method: result.method,
    user_id: result.userId,
    session_id: result.session.id,
    evicted_sessions: result.session.evicted.length,
  });
  return result;
}

/** Whether any upstream provider is configured, for showing social sign-in at all. */
export function socialEnabled(ctx: Context): boolean {
  return anySocialEnabled(ctx.config.features.auth.social);
}

/** Whether this particular provider is configured. */
export function socialProviderEnabled(ctx: Context, providerId: string): boolean {
  return findSocialProvider(ctx.config.features.auth.social, providerId) !== undefined;
}

export async function startSocial(
  { ctx, log, identity }: FlowInput,
  input: {
    providerId: string;
    intent: SocialIntent;
    userId: string | null;
    returnTo: string | null;
    locale: string | null;
  },
): Promise<Awaited<ReturnType<typeof beginSocial>>> {
  const store = oauthStoreOf(ctx);
  if (store === undefined) return { status: 'disabled' };
  const result = await beginSocial(store, {
    social: ctx.config.features.auth.social,
    providerId: input.providerId,
    intent: input.intent,
    userId: input.userId,
    sessionId: identity?.sid ?? null,
    returnTo: input.returnTo,
    locale: input.locale,
    redirectUri: socialCallbackUrl(ctx.config, input.providerId),
    realm: accountOrigin(ctx.config),
    now: new Date(),
  });
  if (result.status === 'ok') {
    log.info('social sign-in started', { provider: input.providerId, intent: input.intent });
  }
  return result;
}

async function noteSocialComplete(
  { ctx, log }: FlowInput,
  providerId: string,
  result: CompleteSocialResult,
): Promise<void> {
  const metrics = identityMetrics(ctx.metrics);
  const method = metricMethod(
    findSocialProvider(ctx.config.features.auth.social, providerId)?.type ?? providerId,
  );
  switch (result.status) {
    case 'invalid':
    case 'denied':
      metrics.signIn(method, 'failure');
      log.info('social sign-in rejected', { provider: providerId, reason: result.status });
      break;
    case 'provider_unavailable':
      metrics.signIn(method, 'failure');
      log.info('social provider unavailable', { provider: providerId });
      break;
    case 'identity_in_use':
    case 'account_limit':
    case 'parental_consent_required':
      log.info('social sign-in refused', { provider: providerId, reason: result.status });
      break;
    case 'linked':
      log.info('social identity linked', {
        provider: providerId,
        user_id: result.userId,
        identity_id: result.identityId,
      });
      break;
    case 'signup_required':
      log.info('social signup required', { provider: providerId });
      break;
    case 'signed_in':
      ctx.outbox.wake();
      if (result.created && result.ageBand !== undefined) {
        metrics.signup(method, result.ageBand);
      }
      metrics.signIn(method, 'success');
      await trackSession(ctx, method, result.session);
      log.info('signed in', {
        method,
        user_id: result.userId,
        session_id: result.session.id,
        evicted_sessions: result.session.evicted.length,
      });
      break;
  }
}

export async function finishSocial(
  input: FlowInput,
  args: {
    providerId: string;
    state: string;
    code: string | undefined;
    params: URLSearchParams;
    error: string | undefined;
  },
): Promise<CompleteSocialResult> {
  const { ctx, request, identity } = input;
  const store = oauthStoreOf(ctx);
  if (store === undefined) return { status: 'invalid' };
  const result = await completeSocial(ctx.db, store, {
    social: ctx.config.features.auth.social,
    providerId: args.providerId,
    state: args.state,
    binding: request.headers.get(FLOW_BINDING_HEADER),
    sessionId: identity?.sid ?? null,
    code: args.code,
    params: args.params,
    error: args.error,
    client: clientFor(ctx, request),
    settings: socialSettings(ctx.config),
    now: new Date(),
  });
  await noteSocialComplete(input, args.providerId, result);
  return result;
}

export async function completeSocialSignup(
  { ctx, request, log }: FlowInput,
  input: { challenge: string; dateOfBirth: string | undefined; email: string | undefined },
): Promise<Awaited<ReturnType<typeof finishSocialSignup>>> {
  const metrics = identityMetrics(ctx.metrics);
  const result = await finishSocialSignup(ctx.db, {
    challenge: input.challenge,
    dateOfBirth: input.dateOfBirth,
    email: input.email,
    client: clientFor(ctx, request),
    settings: socialSettings(ctx.config),
    now: new Date(),
  });
  switch (result.status) {
    case 'invalid':
      log.info('social signup rejected');
      break;
    case 'account_limit':
      log.info('signup refused: too many accounts with this email address');
      break;
    case 'parental_consent_required':
      log.info('signup refused: parental consent is not available');
      break;
    case 'signed_in': {
      ctx.outbox.wake();
      const method = metricMethod(result.method);
      metrics.signup(method, result.ageBand);
      await trackSession(ctx, method, result.session);
      log.info('account created', {
        method,
        user_id: result.userId,
        session_id: result.session.id,
        age_band: result.ageBand,
      });
      if (result.verifyEmail !== null) {
        await sendEmailVerification(
          { ctx, request, log },
          {
            email: result.verifyEmail.address,
            locale: result.verifyEmail.locale ?? ctx.config.email.default_locale,
          },
        );
      }
      break;
    }
  }
  return result;
}

export async function requestEmailChange(
  { ctx, log }: FlowInput,
  input: { userId: string; email: string },
): Promise<Awaited<ReturnType<typeof startEmailChange>>> {
  const result = await startEmailChange(ctx.db, {
    userId: input.userId,
    email: input.email,
    settings: emailChangeSettings(ctx.config),
    now: new Date(),
  });
  if (result.status !== 'started') {
    log.info('email change refused', { reason: result.status });
    return result;
  }
  const locale = result.locale ?? ctx.config.email.default_locale;
  const confirm = await queueEmail(ctx.bus, {
    template: 'email_change',
    to: { address: input.email.trim() },
    locale,
    userId: input.userId,
    variables: {
      link: emailLinkUrl(ctx.config, CHANGE_EMAIL_PAGE, result.confirmToken),
      expires_in_minutes: Math.max(1, Math.ceil(ctx.config.accounts.email_change_ttl / 60_000)),
    },
  });
  const notice = await queueEmail(ctx.bus, {
    template: 'email_change_notice',
    to: { address: result.previousEmail },
    locale,
    userId: input.userId,
    variables: {
      link: emailLinkUrl(ctx.config, REVERT_EMAIL_PAGE, result.revertToken),
      expires_in_days: Math.max(1, Math.ceil(ctx.config.accounts.email_revert_ttl / 86_400_000)),
    },
  });
  log.info('email change started', {
    confirm_delivery_id: confirm.delivery_id,
    notice_delivery_id: notice.delivery_id,
    confirm_expires_at: result.confirmExpiresAt.toISOString(),
    revert_expires_at: result.revertExpiresAt.toISOString(),
  });
  return result;
}

export async function finishEmailChange(
  { ctx, log }: FlowInput,
  input: { token: string },
): Promise<Awaited<ReturnType<typeof confirmEmailChange>>> {
  const result = await confirmEmailChange(ctx.db, {
    token: input.token,
    settings: emailChangeSettings(ctx.config),
    now: new Date(),
  });
  if (result.status === 'confirmed') ctx.outbox.wake();
  log.info(result.status === 'confirmed' ? 'email changed' : 'email change rejected', {
    reason: result.status,
  });
  return result;
}

export async function finishEmailRevert(
  { ctx, log }: FlowInput,
  input: { token: string },
): Promise<Awaited<ReturnType<typeof revertEmailChange>>> {
  const result = await revertEmailChange(ctx.db, {
    token: input.token,
    settings: emailChangeSettings(ctx.config),
    now: new Date(),
  });
  if (result.status === 'reverted') ctx.outbox.wake();
  log.info(result.status === 'reverted' ? 'email change reverted' : 'email revert rejected', {
    reason: result.status,
  });
  return result;
}
