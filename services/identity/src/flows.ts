import { queueEmail } from '@qtiauth/email';
import type { Logger } from '@qtiauth/observability';

import {
  completeSignup,
  issueMagicLink,
  MAGIC_LINK_METHOD,
  type SignupResult,
  verifyMagicLink,
  type VerifyResult,
} from './magic-links.ts';
import { identityMetrics } from './metrics.ts';
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
import type { Context } from './service.ts';
import {
  clientIp,
  emailLinkUrl,
  encryptionKey,
  magicLinkSettings,
  magicLinkUrl,
  passwordSettings,
  RESET_PASSWORD_PAGE,
  sessionClient,
  sessionSettings,
  VERIFY_EMAIL_PAGE,
} from './settings.ts';
import { completeSecondFactor } from './two-factor.ts';

export interface FlowInput {
  ctx: Context;
  request: Request;
  log: Logger;
}

function expiresInMinutes(ms: number): number {
  return Math.max(1, Math.ceil(ms / 60_000));
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
  { ctx, request, log }: FlowInput,
  input: { token: string; userId: string | undefined },
): Promise<VerifyResult> {
  const metrics = identityMetrics(ctx.metrics);
  const result = await verifyMagicLink(ctx.db, {
    token: input.token,
    userId: input.userId,
    client: sessionClient(ctx.config, request),
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
      metrics.sessionCreated(MAGIC_LINK_METHOD, result.session.evicted.length);
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
  { ctx, request, log }: FlowInput,
  input: { signupToken: string; dateOfBirth: string },
): Promise<SignupResult> {
  const metrics = identityMetrics(ctx.metrics);
  const result = await completeSignup(ctx.db, {
    signupToken: input.signupToken,
    dateOfBirth: input.dateOfBirth,
    client: sessionClient(ctx.config, request),
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
      metrics.sessionCreated(MAGIC_LINK_METHOD, result.session.evicted.length);
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
  { ctx, request, log }: FlowInput,
  input: { email: string; password: string },
): Promise<PasswordLoginResult> {
  const metrics = identityMetrics(ctx.metrics);
  const result = await loginWithPassword(ctx.db, {
    email: input.email,
    password: input.password,
    ip: clientIp(request),
    client: sessionClient(ctx.config, request),
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
      metrics.sessionCreated(PASSWORD_METHOD, result.session.evicted.length);
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
  { ctx, request, log }: FlowInput,
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
    client: sessionClient(ctx.config, request),
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
      metrics.sessionCreated(PASSWORD_METHOD, result.session.evicted.length);
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
  { ctx, request, log }: FlowInput,
  input: { token: string },
): Promise<EmailVerifyResult> {
  const result = await verifyEmailAddress(ctx.db, {
    token: input.token,
    client: sessionClient(ctx.config, request),
    settings: passwordSettings(ctx.config),
    now: new Date(),
  });
  switch (result.status) {
    case 'invalid':
      log.info('email verification rejected', { reason: result.reason });
      break;
    case 'signed_in':
      ctx.outbox.wake();
      identityMetrics(ctx.metrics).sessionCreated(PASSWORD_METHOD, result.session.evicted.length);
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
      log.info(result.added ? 'password added' : 'password changed', { user_id: input.userId });
      break;
  }
  return result;
}

export async function finishTwoFactor(
  { ctx, request, log }: FlowInput,
  input: { challenge: string; totp?: string | undefined; recoveryCode?: string | undefined },
): Promise<Awaited<ReturnType<typeof completeSecondFactor>>> {
  const metrics = identityMetrics(ctx.metrics);
  const factor = input.totp !== undefined ? 'totp' : 'recovery';
  const result = await completeSecondFactor(ctx.db, {
    challenge: input.challenge,
    totp: input.totp,
    recoveryCode: input.recoveryCode,
    key: encryptionKey(ctx.config),
    client: sessionClient(ctx.config, request),
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
  metrics.sessionCreated(result.authMethod, result.session.evicted.length);
  log.info('signed in', {
    method: result.method,
    user_id: result.userId,
    session_id: result.session.id,
    evicted_sessions: result.session.evicted.length,
  });
  return result;
}
