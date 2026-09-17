import { randomUUIDv7 } from 'node:crypto';

import { writeEvent } from '@qtiauth/bus';
import type { CountryChangePolicy } from '@qtiauth/config';
import { deletedRows } from '@qtiauth/db';
import { ipSubnet, normalizeCountry } from '@qtiauth/geoip';
import type { Kysely } from 'kysely';

import type { Database, SecurityEventKind } from './database.ts';
import { sessionFlaggedEvent } from './events.ts';
import {
  type TrustLevel,
  type TrustSignals,
  trustLevelForScore,
  trustScore,
  worseTrust,
} from './trust.ts';

export interface SessionSecuritySettings {
  enabled: boolean;
  onCountryChange: CountryChangePolicy;
  alertMinInterval: number;
}

export interface RequestSignals {
  ip: string;
  userAgent: string | null;
  country: string | null;
  tlsFingerprint: string | null;
  timezone: string | null;
  screen: string | null;
  clientFingerprint: string | null;
}

export type SecurityAction = 'none' | 'challenge' | 'block' | 'notify';

export interface SecurityOutcome {
  trust: TrustLevel;
  acr: string;
  action: SecurityAction;
  countryChanged: boolean;
  reason: 'country_change' | 'trust' | null;
}

export function currentSignals(
  request: RequestSignals,
  lookupCountry: (ip: string) => string | null,
): TrustSignals {
  const ip = request.ip === '' ? null : request.ip;
  return {
    ip,
    subnet: ip === null ? null : ipSubnet(ip),
    country: normalizeCountry(request.country) ?? (ip === null ? null : lookupCountry(ip)),
    userAgent: request.userAgent,
    tlsFingerprint: request.tlsFingerprint,
    timezone: request.timezone,
    screen: request.screen,
    clientFingerprint: request.clientFingerprint,
  };
}

export function baselineFromSession(session: {
  ip: string | null;
  ip_subnet: string | null;
  country: string | null;
  user_agent: string | null;
  tls_fingerprint: string | null;
  timezone: string | null;
  screen: string | null;
  client_fingerprint: string | null;
}): TrustSignals {
  return {
    ip: session.ip,
    subnet: session.ip_subnet,
    country: session.country,
    userAgent: session.user_agent,
    tlsFingerprint: session.tls_fingerprint,
    timezone: session.timezone,
    screen: session.screen,
    clientFingerprint: session.client_fingerprint,
  };
}

export function evaluateSecurity(
  baseline: TrustSignals,
  current: TrustSignals,
  currentAcr: string,
  policy: CountryChangePolicy,
): SecurityOutcome {
  const countryChanged =
    baseline.country !== null && current.country !== null && baseline.country !== current.country;

  if (currentAcr === 'aal0') {
    return {
      trust: 'challenge',
      acr: 'aal0',
      action: countryChanged && policy === 'block' ? 'block' : 'none',
      countryChanged,
      reason: countryChanged && policy === 'block' ? 'country_change' : null,
    };
  }

  if (countryChanged && policy === 'challenge') {
    return {
      trust: 'challenge',
      acr: 'aal0',
      action: 'challenge',
      countryChanged: true,
      reason: 'country_change',
    };
  }
  if (countryChanged && policy === 'block') {
    return {
      trust: 'blocked',
      acr: currentAcr,
      action: 'block',
      countryChanged: true,
      reason: 'country_change',
    };
  }

  const scored = { ...current };
  if (countryChanged && (policy === 'ignore' || policy === 'notify')) {
    scored.country = baseline.country;
  }
  const level = trustLevelForScore(trustScore(baseline, scored));
  if (level === 'blocked') {
    return {
      trust: 'blocked',
      acr: currentAcr,
      action: 'block',
      countryChanged,
      reason: countryChanged ? 'country_change' : 'trust',
    };
  }
  if (level === 'challenge') {
    return {
      trust: 'challenge',
      acr: 'aal0',
      action: 'challenge',
      countryChanged,
      reason: countryChanged ? 'country_change' : 'trust',
    };
  }
  return {
    trust: countryChanged && policy === 'notify' ? worseTrust(level, 'partial') : level,
    acr: currentAcr,
    action: countryChanged && policy === 'notify' ? 'notify' : 'none',
    countryChanged,
    reason: countryChanged ? 'country_change' : null,
  };
}

export async function recordSecurityEvent(
  trx: Kysely<Database>,
  event: {
    userId: string;
    sessionId: string | null;
    kind: SecurityEventKind;
    trustFrom: string | null;
    trustTo: string | null;
    countryFrom: string | null;
    countryTo: string | null;
    notified: boolean;
    now: Date;
  },
): Promise<void> {
  await trx
    .insertInto('session_security_events')
    .values({
      id: randomUUIDv7(),
      user_id: event.userId,
      session_id: event.sessionId,
      kind: event.kind,
      trust_from: event.trustFrom,
      trust_to: event.trustTo,
      country_from: event.countryFrom,
      country_to: event.countryTo,
      notified: event.notified,
      created_at: event.now,
    })
    .execute();
}

export async function recentlyNotified(
  db: Kysely<Database>,
  userId: string,
  since: Date,
): Promise<boolean> {
  const row = await db
    .selectFrom('session_security_events')
    .select('id')
    .where('user_id', '=', userId)
    .where('notified', '=', true)
    .where('created_at', '>', since)
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}

export async function sweepSecurityEvents(
  db: Kysely<Database>,
  options: { retention: number; now: Date },
): Promise<number> {
  const cutoff = new Date(options.now.getTime() - options.retention);
  const result = await db
    .deleteFrom('session_security_events')
    .where('created_at', '<', cutoff)
    .execute();
  return deletedRows(result);
}

export async function applyResolvedSecurity(
  trx: Kysely<Database>,
  options: {
    sessionId: string;
    userId: string;
    acr: string;
    trustLevel: string;
    baseline: TrustSignals;
    current: TrustSignals;
    settings: SessionSecuritySettings;
    now: Date;
  },
): Promise<{
  acr: string;
  trustLevel: TrustLevel;
  blocked: boolean;
  notify: boolean;
  countryFrom: string | null;
  countryTo: string | null;
}> {
  const outcome = evaluateSecurity(
    options.baseline,
    options.current,
    options.acr,
    options.settings.onCountryChange,
  );
  const notify = outcome.action === 'notify' || outcome.action === 'block';
  const changed = outcome.action !== 'none' || outcome.trust !== options.trustLevel;
  if (outcome.action !== 'block') {
    const patch: {
      acr?: string;
      trust_level?: TrustLevel;
      last_country?: string | null;
      step_up_at?: Date | null;
    } = { last_country: options.current.country };
    if (outcome.acr !== options.acr || outcome.trust !== options.trustLevel) {
      patch.acr = outcome.acr;
      patch.trust_level = outcome.trust;
      if (outcome.acr === 'aal0') patch.step_up_at = null;
    }
    await trx.updateTable('sessions').set(patch).where('id', '=', options.sessionId).execute();
  }

  if (changed) {
    await recordSecurityEvent(trx, {
      userId: options.userId,
      sessionId: options.sessionId,
      kind: outcome.countryChanged ? 'country_change' : 'trust_transition',
      trustFrom: options.trustLevel,
      trustTo: outcome.trust,
      countryFrom: options.baseline.country,
      countryTo: options.current.country,
      notified: false,
      now: options.now,
    });
    if (outcome.action === 'challenge' || outcome.action === 'block') {
      await writeEvent(
        trx,
        sessionFlaggedEvent({
          session_id: options.sessionId,
          user_id: options.userId,
          reason: outcome.reason ?? 'trust',
          trust_level: outcome.trust,
          acr: outcome.action === 'block' ? options.acr : outcome.acr,
        }),
      );
    }
  }

  return {
    acr: outcome.acr,
    trustLevel: outcome.trust,
    blocked: outcome.action === 'block',
    notify,
    countryFrom: options.baseline.country,
    countryTo: options.current.country,
  };
}
