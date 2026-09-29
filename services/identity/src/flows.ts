import { queueEmail } from '@qtiauth/email';
import type { Logger } from '@qtiauth/observability';
import { FLOW_BINDING_HEADER } from '@qtiauth/service-kit';

import { dateOfBirthColumn, findAccount } from './accounts.ts';
import { ageOn, under18 } from './age.ts';
import type { DataExportStatus } from './database.ts';
import { confirmEmailChange, revertEmailChange, startEmailChange } from './email-change.ts';
import {
  completeExport,
  type CompleteExportOptions,
  requestExport,
  resumePendingExports,
} from './exports.ts';
import {
  childLabel,
  childrenNeedingActivitySummary,
  hasActiveGuardians,
  listActiveGuardians,
  markActivitySummarySent,
  requestUsernameChange,
  utcDateString,
  type Guardian,
} from './family.ts';
import { familyChildActivity, formatConnectedApps } from './family-apps.ts';
import { applyFilter } from './filter.ts';
import {
  childrenNeedingGraduationNotice,
  markGraduationNotified,
  markRemovalReminded,
  pendingRemovalsForReminder,
} from './graduation.ts';
import { acceptLegalDocuments } from './legal.ts';
import { requestDeletion } from './lifecycle.ts';
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
  approveConsent,
  changeGuardianEmail,
  CHILDREN_SUMMARY_ID,
  type ConsentLinks,
  declineConsent,
  findPendingConsent,
  presentConsent,
  resendConsent,
} from './parental.ts';
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
import { loadActiveRestrictions, USERNAME_CHANGE_RESTRICTION } from './restrictions.ts';
import type { Context } from './service.ts';
import type { CreatedSession } from './sessions.ts';
import {
  accountOrigin,
  CHANGE_EMAIL_PAGE,
  clientFor,
  clientIp,
  emailChangeSettings,
  emailLinkUrl,
  encryptionKey,
  FAMILY_INVITE_PAGE,
  FAMILY_SESSION_PAGE,
  familyChildUrl,
  familyDashboardUrl,
  familyLeaveUrl,
  GUARDIAN_APPROVE_PAGE,
  GUARDIAN_DECLINE_PAGE,
  legalDocumentUrl,
  magicLinkSettings,
  magicLinkUrl,
  parentalSettings,
  passwordSettings,
  RESET_PASSWORD_PAGE,
  REVERT_EMAIL_PAGE,
  sessionSettings,
  socialCallbackUrl,
  socialSettings,
  VERIFY_EMAIL_PAGE,
} from './settings.ts';
import {
  beginSocial,
  completeSocial,
  type CompleteSocialResult,
  finishSocialSignup,
} from './social.ts';
import { objectStoreOf } from './storage-state.ts';
import { completeSecondFactor } from './two-factor.ts';
import { claimUsername, type ClaimUsernameResult } from './usernames.ts';

export type ChooseUsernameResult =
  | ClaimUsernameResult
  | { status: 'pending'; username: string }
  | { status: 'already_pending' }
  | { status: 'restricted' };

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
  const sessionRow = await ctx.db
    .selectFrom('sessions')
    .innerJoin('users', 'users.id', 'sessions.user_id')
    .select(['sessions.user_id as user_id', 'users.username as username'])
    .where('sessions.id', '=', session.id)
    .executeTakeFirst();
  if (sessionRow) {
    const guardians = await listActiveGuardians(ctx.db, sessionRow.user_id);
    const link = familyChildUrl(ctx.config, sessionRow.user_id);
    for (const guardian of guardians) {
      await queueEmail(ctx.bus, {
        template: 'guardian_new_device',
        to: { address: guardian.email },
        locale: notice.locale ?? ctx.config.email.default_locale,
        userId: guardian.user_id,
        variables: {
          username: childLabel(sessionRow.username),
          browser: notice.browser,
          os: notice.os,
          place: notice.place,
          link,
        },
      });
    }
  }
  await ctx.db
    .updateTable('session_security_events')
    .set({ notified: true })
    .where('session_id', '=', session.id)
    .where('kind', '=', 'new_device')
    .execute();
}

export async function trackSession(
  ctx: Context,
  method: string,
  session: CreatedSession,
): Promise<void> {
  if (!session.restored)
    identityMetrics(ctx.metrics).sessionCreated(method, session.evicted.length);
  if (session.cancelledDeletion) identityMetrics(ctx.metrics).deletion('cancelled');
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

function expiresInDays(ms: number): number {
  return Math.max(1, Math.ceil(ms / 86_400_000));
}

export async function sendParentalConsentEmail(ctx: Context, links: ConsentLinks): Promise<void> {
  const remaining = links.expiresAt.getTime() - Date.now();
  await queueEmail(ctx.bus, {
    template: 'parental_consent',
    to: { address: links.email },
    locale: links.locale ?? ctx.config.email.default_locale,
    variables: {
      approve_link: emailLinkUrl(ctx.config, GUARDIAN_APPROVE_PAGE, links.approveToken),
      decline_link: emailLinkUrl(ctx.config, GUARDIAN_DECLINE_PAGE, links.declineToken),
      children_summary_link: legalDocumentUrl(ctx.config, CHILDREN_SUMMARY_ID),
      expires_in_days: expiresInDays(remaining),
    },
  });
  identityMetrics(ctx.metrics).parentalConsent('requested');
}

export async function resendParentalConsent(
  { ctx, log }: FlowInput,
  input: { userId: string },
): Promise<Awaited<ReturnType<typeof resendConsent>>> {
  const account = await findAccount(ctx.db, input.userId);
  if (!account) return { status: 'not_pending' };
  const result = await resendConsent(ctx.db, {
    userId: input.userId,
    locale: account.locale,
    pendingTtl: ctx.config.parental.pending_ttl,
    now: new Date(),
  });
  if (result.status === 'ok') {
    await sendParentalConsentEmail(ctx, result.links);
    ctx.outbox.wake();
    log.info('parental consent email resent', { user_id: input.userId });
  } else {
    log.info('parental consent resend refused');
  }
  return result;
}

export async function updateGuardianEmail(
  { ctx, log }: FlowInput,
  input: { userId: string; email: string },
): Promise<Awaited<ReturnType<typeof changeGuardianEmail>>> {
  const account = await findAccount(ctx.db, input.userId);
  if (!account) return { status: 'not_pending' };
  const settings = parentalSettings(ctx.config);
  const result = await changeGuardianEmail(ctx.db, {
    userId: input.userId,
    email: input.email,
    locale: account.locale,
    childNormalized: settings.normalizeEmail(account.email),
    settings,
    now: new Date(),
  });
  if (result.status === 'ok') {
    await sendParentalConsentEmail(ctx, result.links);
    ctx.outbox.wake();
    log.info('guardian email changed', { user_id: input.userId });
  } else {
    log.info('guardian email change refused', { reason: result.status });
  }
  return result;
}

export async function grantParentalConsent(
  { ctx, request, log }: FlowInput,
  input: { token: string; dateOfBirth: string },
): Promise<Awaited<ReturnType<typeof approveConsent>>> {
  const result = await approveConsent(ctx.db, {
    token: input.token,
    dateOfBirth: input.dateOfBirth,
    ip: clientIp(request) || null,
    settings: parentalSettings(ctx.config),
    now: new Date(),
  });
  switch (result.status) {
    case 'ok':
      identityMetrics(ctx.metrics).parentalConsent('granted');
      ctx.outbox.wake();
      log.info('parental consent granted', { user_id: result.userId });
      break;
    case 'not_adult':
      log.info('parental consent refused: guardian is not an adult');
      break;
    case 'invalid':
      log.info('parental consent approve rejected', { reason: result.reason });
      break;
  }
  return result;
}

export async function refuseParentalConsent(
  { ctx, log }: FlowInput,
  input: { token: string },
): Promise<Awaited<ReturnType<typeof declineConsent>>> {
  const result = await declineConsent(ctx.db, { token: input.token, now: new Date() });
  if (result.status === 'ok') {
    identityMetrics(ctx.metrics).parentalConsent('declined');
    identityMetrics(ctx.metrics).deletion('completed');
    ctx.outbox.wake();
    log.info('parental consent declined', { user_id: result.userId });
  } else {
    log.info('parental consent decline rejected', { reason: result.reason });
  }
  return result;
}

export async function pendingParentalConsent(ctx: Context, userId: string) {
  const row = await findPendingConsent(ctx.db, userId);
  if (!row) return null;
  return presentConsent(row, ctx.config.parental.pending_ttl);
}

export async function signup(
  { ctx, request, log, identity }: FlowInput,
  input: { signupToken: string; dateOfBirth: string; guardianEmail: string | undefined },
): Promise<SignupResult> {
  const metrics = identityMetrics(ctx.metrics);
  const result = await completeSignup(ctx.db, {
    signupToken: input.signupToken,
    dateOfBirth: input.dateOfBirth,
    guardianEmail: input.guardianEmail,
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
      log.info('signup refused: admin invites cannot create child accounts');
      break;
    case 'guardian_email_required':
      log.info('signup needs a parent or guardian email');
      break;
    case 'guardian_email_invalid':
      log.info('signup refused: parent or guardian email is not usable');
      break;
    case 'signed_in':
      ctx.outbox.wake();
      metrics.signup(MAGIC_LINK_METHOD, result.ageBand);
      await trackSession(ctx, MAGIC_LINK_METHOD, result.session);
      if (result.consent !== null) await sendParentalConsentEmail(ctx, result.consent);
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
  { ctx, request, log }: FlowInput,
  input: {
    email: string;
    password: string;
    dateOfBirth: string;
    guardianEmail: string | undefined;
    locale: string;
  },
): Promise<PasswordSignupResult> {
  const metrics = identityMetrics(ctx.metrics);
  const result = await completePasswordSignup(ctx.db, {
    email: input.email,
    password: input.password,
    dateOfBirth: input.dateOfBirth,
    guardianEmail: input.guardianEmail,
    locale: input.locale,
    ip: clientIp(request) || null,
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
      log.info('signup refused: admin invites cannot create child accounts');
      break;
    case 'guardian_email_required':
      log.info('signup needs a parent or guardian email');
      break;
    case 'guardian_email_invalid':
      log.info('signup refused: parent or guardian email is not usable');
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
      if (result.consent !== null) await sendParentalConsentEmail(ctx, result.consent);
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

export function socialEnabled(ctx: Context): boolean {
  return anySocialEnabled(ctx.config.features.auth.social);
}

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
    case 'guardian_email_required':
    case 'guardian_email_invalid':
    case 'unlink_cooldown':
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
  input: {
    challenge: string;
    dateOfBirth: string | undefined;
    email: string | undefined;
    guardianEmail: string | undefined;
  },
): Promise<Awaited<ReturnType<typeof finishSocialSignup>>> {
  const metrics = identityMetrics(ctx.metrics);
  const result = await finishSocialSignup(ctx.db, {
    challenge: input.challenge,
    dateOfBirth: input.dateOfBirth,
    email: input.email,
    guardianEmail: input.guardianEmail,
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
      log.info('signup refused: admin invites cannot create child accounts');
      break;
    case 'guardian_email_required':
      log.info('signup needs a parent or guardian email');
      break;
    case 'guardian_email_invalid':
      log.info('signup refused: parent or guardian email is not usable');
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
      if (result.consent !== null) await sendParentalConsentEmail(ctx, result.consent);
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

function exportOptions(ctx: Context): CompleteExportOptions {
  return {
    store: objectStoreOf(ctx),
    settings: {
      ttl: ctx.config.accounts.export_ttl,
      emailMaxBytes: ctx.config.accounts.export_email_max_bytes,
      defaultLocale: ctx.config.email.default_locale,
    },
    metrics: ctx.busMetrics,
    onError: (error, code) => {
      ctx.log.error('data export step failed', { error, code });
    },
    now: new Date(),
  };
}

function recordExportStatus(ctx: Context, status: DataExportStatus): void {
  if (status !== 'pending') identityMetrics(ctx.metrics).dataExport(status);
}

export async function startDataExport(
  { ctx, log }: FlowInput,
  input: { userId: string },
): Promise<Awaited<ReturnType<typeof requestExport>>> {
  const result = await requestExport(ctx.db, { userId: input.userId, now: new Date() });
  if (result.status === 'not_found') return result;
  void completeExport(ctx.db, ctx.bus, result.id, exportOptions(ctx)).then(
    (status) => {
      recordExportStatus(ctx, status);
    },
    (error: unknown) => {
      ctx.log.error('data export failed', { error, export_id: result.id });
    },
  );
  log.info('data export requested', { user_id: input.userId, export_id: result.id });
  return result;
}

export async function resumeDataExports(ctx: Context): Promise<number> {
  return resumePendingExports(ctx.db, ctx.bus, {
    ...exportOptions(ctx),
    onCompleted: (status) => {
      recordExportStatus(ctx, status);
    },
  });
}

export async function scheduleDeletion(
  { ctx, log }: FlowInput,
  input: { userId: string },
): Promise<Awaited<ReturnType<typeof requestDeletion>>> {
  const result = await requestDeletion(ctx.db, {
    userId: input.userId,
    actor: { type: 'user', id: input.userId },
    now: new Date(),
  });
  if (result.status !== 'ok') return result;
  ctx.outbox.wake();
  identityMetrics(ctx.metrics).deletion('requested');
  identityMetrics(ctx.metrics).sessionsRevoked('revoked', result.revoked.length);
  log.info('account deletion requested', { user_id: input.userId });
  return result;
}

export async function acceptLegal(
  { ctx, request, log }: FlowInput,
  input: { userId: string; documents: readonly { id: string; version: string }[] },
): Promise<Awaited<ReturnType<typeof acceptLegalDocuments>>> {
  const result = await acceptLegalDocuments(ctx.db, {
    userId: input.userId,
    documents: input.documents,
    ip: clientIp(request) || null,
    now: new Date(),
  });
  if (result.status !== 'ok') return result;
  ctx.outbox.wake();
  log.info('legal documents accepted', { user_id: input.userId, accepted: result.accepted });
  return result;
}

export async function chooseUsername(
  { ctx, log }: FlowInput,
  input: { userId: string; username: string },
): Promise<ChooseUsernameResult> {
  const account = await findAccount(ctx.db, input.userId);
  if (account && !account.username_reset_required) {
    const names = await loadActiveRestrictions(ctx.db, input.userId, new Date());
    if (names.includes(USERNAME_CHANGE_RESTRICTION)) return { status: 'restricted' };
  }
  const isBlocked = async (username: string) =>
    (await applyFilter(ctx, username, 'username')).decision === 'block';
  if (account?.username && (await hasActiveGuardians(ctx.db, input.userId))) {
    const pending = await requestUsernameChange(ctx.db, {
      userId: input.userId,
      username: input.username,
      settings: ctx.config.usernames,
      isBlocked,
      now: new Date(),
    });
    if (pending.status === 'pending') {
      const guardians = await listActiveGuardians(ctx.db, input.userId);
      const link = familyChildUrl(ctx.config, input.userId);
      for (const guardian of guardians) {
        await queueEmail(ctx.bus, {
          template: 'guardian_username_change',
          to: { address: guardian.email },
          locale: account.locale ?? ctx.config.email.default_locale,
          userId: guardian.user_id,
          variables: { username: pending.username, link },
        });
      }
      ctx.outbox.wake();
      log.info('username change awaiting guardian', { user_id: input.userId });
      return { status: 'pending', username: pending.username };
    }
    if (pending.status === 'already_pending') return pending;
    return pending;
  }
  const result = await claimUsername(ctx.db, {
    userId: input.userId,
    username: input.username,
    settings: ctx.config.usernames,
    isBlocked,
    now: new Date(),
  });
  if (result.status !== 'saved') return result;
  identityMetrics(ctx.metrics).username(result.action);
  ctx.outbox.wake();
  log.info('username set', { user_id: input.userId, action: result.action });
  return result;
}

export async function sendFamilyAccessEmail(
  ctx: Context,
  issued: { token: string; email: string; locale: string | null; expiresAt: Date },
): Promise<void> {
  await queueEmail(ctx.bus, {
    template: 'family_access',
    to: { address: issued.email },
    locale: issued.locale ?? ctx.config.email.default_locale,
    variables: {
      link: emailLinkUrl(ctx.config, FAMILY_SESSION_PAGE, issued.token),
      expires_in_minutes: expiresInMinutes(issued.expiresAt.getTime() - Date.now()),
    },
  });
}

export async function sendFamilyInviteEmail(
  ctx: Context,
  issued: { token: string; email: string; locale: string | null; expiresAt: Date },
): Promise<void> {
  await queueEmail(ctx.bus, {
    template: 'family_invite',
    to: { address: issued.email },
    locale: issued.locale ?? ctx.config.email.default_locale,
    variables: {
      link: emailLinkUrl(ctx.config, FAMILY_INVITE_PAGE, issued.token),
      expires_in_minutes: expiresInMinutes(issued.expiresAt.getTime() - Date.now()),
    },
  });
}

export async function sendFamilyActivitySummaries(ctx: Context, now = new Date()): Promise<number> {
  const periodStart = utcDateString(new Date(now.getTime() - 7 * 86_400_000));
  const children = await childrenNeedingActivitySummary(ctx.db, periodStart);
  let sent = 0;
  for (const child of children) {
    const marked = await markActivitySummarySent(ctx.db, {
      childUserId: child.child_user_id,
      periodStart,
      now,
    });
    if (!marked) continue;
    const activity = await familyChildActivity(ctx, { childUserId: child.child_user_id, now });
    const guardians = await listActiveGuardians(ctx.db, child.child_user_id);
    const link = familyChildUrl(ctx.config, child.child_user_id);
    for (const guardian of guardians) {
      await queueEmail(ctx.bus, {
        template: 'guardian_activity',
        to: { address: guardian.email },
        locale: child.locale ?? ctx.config.email.default_locale,
        userId: guardian.user_id,
        variables: {
          username: childLabel(child.username),
          sign_ins: activity.sign_ins,
          connected_apps: formatConnectedApps(activity.connected_apps),
          link,
        },
      });
      sent += 1;
    }
  }
  return sent;
}

async function notifyGuardiansOfRemoval(
  ctx: Context,
  options: { username: string | null; locale: string | null; guardians: Guardian[] },
): Promise<void> {
  const username = childLabel(options.username);
  for (const guardian of options.guardians) {
    if (guardian.status !== 'active') continue;
    await queueEmail(ctx.bus, {
      template: 'guardian_removed',
      to: { address: guardian.email },
      locale: options.locale ?? ctx.config.email.default_locale,
      userId: guardian.user_id,
      variables: { username },
    });
  }
}

export async function sendGuardianRemovalRequestEmail(
  ctx: Context,
  options: { childUserId: string; username: string | null; locale: string | null },
): Promise<void> {
  const guardians = await listActiveGuardians(ctx.db, options.childUserId);
  const link = familyChildUrl(ctx.config, options.childUserId);
  const username = childLabel(options.username);
  for (const guardian of guardians) {
    await queueEmail(ctx.bus, {
      template: 'guardian_removal_request',
      to: { address: guardian.email },
      locale: options.locale ?? ctx.config.email.default_locale,
      userId: guardian.user_id,
      variables: { username, link },
    });
  }
}

export async function sendGuardianRemovedEmail(
  ctx: Context,
  options: { username: string | null; locale: string | null; guardians: Guardian[] },
): Promise<void> {
  await notifyGuardiansOfRemoval(ctx, options);
}

export async function sendGraduationNotices(ctx: Context, now = new Date()): Promise<number> {
  const children = await childrenNeedingGraduationNotice(ctx.db, {
    consentAge: ctx.config.parental.consent_age,
    now,
  });
  const graceDays = expiresInDays(ctx.config.parental.graduation_grace);
  let sent = 0;
  for (const child of children) {
    const marked = await markGraduationNotified(ctx.db, {
      userId: child.user_id,
      consentAge: ctx.config.parental.consent_age,
      now,
    });
    if (!marked) continue;
    const leaveLink = familyLeaveUrl(ctx.config);
    const familyLink = familyDashboardUrl(ctx.config);
    await queueEmail(ctx.bus, {
      template: 'graduation',
      to: { address: child.email },
      locale: child.locale ?? ctx.config.email.default_locale,
      userId: child.user_id,
      variables: { grace_days: graceDays, link: leaveLink },
    });
    const guardians = await listActiveGuardians(ctx.db, child.user_id);
    for (const guardian of guardians) {
      await queueEmail(ctx.bus, {
        template: 'guardian_graduation',
        to: { address: guardian.email },
        locale: child.locale ?? ctx.config.email.default_locale,
        userId: guardian.user_id,
        variables: {
          username: childLabel(child.username),
          grace_days: graceDays,
          link: familyLink,
        },
      });
    }
    sent += 1;
  }
  return sent;
}

export async function sendGuardianRemovalReminders(
  ctx: Context,
  now = new Date(),
): Promise<number> {
  const pending = await pendingRemovalsForReminder(ctx.db, now);
  let sent = 0;
  for (const row of pending) {
    const marked = await markRemovalReminded(ctx.db, { id: row.id, now });
    if (!marked) continue;
    const guardians = await listActiveGuardians(ctx.db, row.user_id);
    const link = familyChildUrl(ctx.config, row.user_id);
    const username = childLabel(row.username);
    for (const guardian of guardians) {
      await queueEmail(ctx.bus, {
        template: 'guardian_removal_request',
        to: { address: guardian.email },
        locale: row.locale ?? ctx.config.email.default_locale,
        userId: guardian.user_id,
        variables: { username, link },
      });
      sent += 1;
    }
  }
  return sent;
}
