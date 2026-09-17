import type { Metrics } from '@qtiauth/observability';
import { ACCOUNT_STATES, type AccountState, type AgeBand } from '@qtiauth/service-kit';

import type { RevocationReason } from './database.ts';

export type MagicLinkEvent = 'sent' | 'used' | 'expired' | 'invalid';
export type SignInResult = 'success' | 'failure';
export type BreachCheckResult = 'rejected' | 'passed' | 'unavailable';

export interface IdentityMetrics {
  magicLink: (event: MagicLinkEvent) => void;
  signIn: (method: string, result: SignInResult) => void;
  signup: (method: string, band: AgeBand) => void;
  passwordFailure: () => void;
  breachCheck: (result: BreachCheckResult) => void;
  sessionCreated: (method: string, evicted: number) => void;
  sessionsRevoked: (reason: RevocationReason, count: number) => void;
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
    help: 'Sessions ended before they expired, by reason: logout, revoked or evicted.',
    labelNames: ['reason'],
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
    sessionCreated: (method, evicted) => {
      sessionsCreated.inc({ method });
      bindings.inc();
      if (evicted > 0) revoked.inc({ reason: 'evicted' }, evicted);
    },
    sessionsRevoked: (reason, count) => {
      if (count > 0) revoked.inc({ reason }, count);
    },
    accounts: (counts) => {
      for (const state of ACCOUNT_STATES) accounts.set({ state }, counts[state] ?? 0);
    },
    activeSessions: (count) => {
      active.set(count);
    },
  };
}
