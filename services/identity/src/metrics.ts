import type { Metrics } from '@qtiauth/observability';
import { ACCOUNT_STATES, type AccountState, type AgeBand } from '@qtiauth/service-kit';

import type { RevocationReason } from './database.ts';

export type MagicLinkEvent = 'sent' | 'used' | 'expired' | 'invalid';
export type SignInResult = 'success' | 'failure';
export type BreachCheckResult = 'rejected' | 'passed' | 'unavailable';
export type CaptchaResult = 'shown' | 'solved' | 'failed';
export type TwoFactorFactor = 'totp' | 'passkey' | 'recovery';
export type TwoFactorResult = 'success' | 'failure';
export type StepUpResult = 'prompt' | 'success' | 'failure';
export type UsernameAction = 'claim' | 'change' | 'reclaim';

export interface IdentityMetrics {
  magicLink: (event: MagicLinkEvent) => void;
  signIn: (method: string, result: SignInResult) => void;
  signup: (method: string, band: AgeBand) => void;
  passwordFailure: () => void;
  breachCheck: (result: BreachCheckResult) => void;
  captcha: (result: CaptchaResult) => void;
  twoFactor: (factor: TwoFactorFactor, result: TwoFactorResult) => void;
  passkeyRegistration: () => void;
  stepUp: (result: StepUpResult) => void;
  sessionCreated: (method: string, evicted: number) => void;
  bindingCreated: () => void;
  sessionsRevoked: (reason: RevocationReason, count: number) => void;
  filterDecision: (rule: string) => void;
  username: (action: UsernameAction) => void;
  ageBandChanged: (count: number) => void;
  accounts: (counts: Partial<Record<AccountState, number>>) => void;
  activeSessions: (count: number) => void;
}

const created = new WeakMap<Metrics, IdentityMetrics>();

export function identityMetrics(metrics: Metrics): IdentityMetrics {
  let identity = created.get(metrics);
  if (!identity) {
    identity = prometheusIdentityMetrics(metrics);
    created.set(metrics, identity);
  }
  return identity;
}

export function prometheusIdentityMetrics(metrics: Metrics): IdentityMetrics {
  const magicLinks = metrics.counter({
    name: 'qtiauth_auth_magic_links_total',
    help: 'Magic links by what happened: sent, used, expired (opened too late) or invalid (unknown or already used).',
    labelNames: ['event'],
  });
  const signIns = metrics.counter({
    name: 'qtiauth_auth_sign_ins_total',
    help: 'Sign-in attempts, by method and result (success or failure).',
    labelNames: ['method', 'result'],
  });
  const signups = metrics.counter({
    name: 'qtiauth_auth_signups_total',
    help: 'Accounts created, by signup method and age band.',
    labelNames: ['method', 'age_band'],
  });
  const passwordFailures = metrics.counter({
    name: 'qtiauth_auth_password_failures_total',
    help: 'Failed password checks during sign-in.',
  });
  const breachChecks = metrics.counter({
    name: 'qtiauth_auth_breach_checks_total',
    help: 'Have I Been Pwned password checks, by result: rejected, passed or unavailable.',
    labelNames: ['result'],
  });
  const captcha = metrics.counter({
    name: 'qtiauth_auth_captcha_total',
    help: 'CAPTCHA prompts, by result: shown, solved or failed.',
    labelNames: ['result'],
  });
  const twoFactor = metrics.counter({
    name: 'qtiauth_auth_2fa_challenges_total',
    help: 'Two-factor challenges, by factor (totp, passkey or recovery) and result.',
    labelNames: ['factor', 'result'],
  });
  const passkeyRegistrations = metrics.counter({
    name: 'qtiauth_auth_passkey_registrations_total',
    help: 'Passkeys registered.',
  });
  const stepUp = metrics.counter({
    name: 'qtiauth_auth_step_up_total',
    help: 'Step-up prompts and completions, by result: prompt, success or failure.',
    labelNames: ['result'],
  });
  const sessionsCreated = metrics.counter({
    name: 'qtiauth_sessions_created_total',
    help: 'Sessions started, by sign-in method.',
    labelNames: ['method'],
  });
  const bindings = metrics.counter({
    name: 'qtiauth_session_bindings_created_total',
    help: 'Session bindings created. Each ties a session to one cookie scope.',
  });
  const revoked = metrics.counter({
    name: 'qtiauth_sessions_revoked_total',
    help: 'Sessions ended before they expired, by reason: logout, revoked, evicted or blocked.',
    labelNames: ['reason'],
  });
  const filterDecisions = metrics.counter({
    name: 'qtiauth_filter_decisions_total',
    help: 'Text-filter decisions, by rule.',
    labelNames: ['rule'],
  });
  const usernames = metrics.counter({
    name: 'qtiauth_usernames_claimed_total',
    help: 'Username claims, by action: claim, change or reclaim.',
    labelNames: ['action'],
  });
  const ageBandChanges = metrics.counter({
    name: 'qtiauth_age_band_changes_total',
    help: 'Age-band changes from the daily recompute or a staff date-of-birth edit.',
  });
  const accounts = metrics.gauge({
    name: 'qtiauth_accounts',
    help: 'Accounts by state, refreshed every minute.',
    labelNames: ['state'],
  });
  const active = metrics.gauge({
    name: 'qtiauth_sessions_active',
    help: 'Sessions that have not expired, gone idle or been revoked, refreshed every minute.',
  });

  return {
    magicLink: (event) => {
      magicLinks.inc({ event });
    },
    signIn: (method, result) => {
      signIns.inc({ method, result });
    },
    signup: (method, band) => {
      signups.inc({ method, age_band: band });
    },
    passwordFailure: () => {
      passwordFailures.inc();
    },
    breachCheck: (result) => {
      breachChecks.inc({ result });
    },
    captcha: (result) => {
      captcha.inc({ result });
    },
    twoFactor: (factor, result) => {
      twoFactor.inc({ factor, result });
    },
    passkeyRegistration: () => {
      passkeyRegistrations.inc();
    },
    stepUp: (result) => {
      stepUp.inc({ result });
    },
    bindingCreated: () => {
      bindings.inc();
    },
    sessionCreated: (method, evicted) => {
      sessionsCreated.inc({ method });
      bindings.inc();
      if (evicted > 0) revoked.inc({ reason: 'evicted' }, evicted);
    },
    sessionsRevoked: (reason, count) => {
      if (count > 0) revoked.inc({ reason }, count);
    },
    filterDecision: (rule) => {
      filterDecisions.inc({ rule });
    },
    username: (action) => {
      usernames.inc({ action });
    },
    ageBandChanged: (count) => {
      if (count > 0) ageBandChanges.inc(count);
    },
    accounts: (counts) => {
      for (const state of ACCOUNT_STATES) accounts.set({ state }, counts[state] ?? 0);
    },
    activeSessions: (count) => {
      active.set(count);
    },
  };
}
