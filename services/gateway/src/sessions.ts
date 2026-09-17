import { createHash } from 'node:crypto';

import type { RpcResult } from '@qtiauth/bus';
import type { QtiauthConfig } from '@qtiauth/config';
import type { EventEnvelope } from '@qtiauth/events';
import type { Metrics } from '@qtiauth/observability';
import { ACCOUNT_STATES, AGE_BANDS } from '@qtiauth/service-kit';
import { KEY_PREFIX, type Valkey } from '@qtiauth/valkey';
import * as z from 'zod';

export type CookiesConfig = QtiauthConfig['cookies'];

export const RESOLVE_SESSION_SERVICE = 'identity';
export const RESOLVE_SESSION_METHOD = 'resolve_session';

const TOKEN = /^[A-Za-z0-9_-]{32,128}$/;
const CACHE_PREFIX = `${KEY_PREFIX}gateway:session:`;
const EPOCH_PREFIX = `${KEY_PREFIX}gateway:session_epoch:`;

export const resolvedSessionSchema = z.strictObject({
  session_id: z.string().min(1),
  user_id: z.string().min(1),
  account_state: z.enum(ACCOUNT_STATES),
  permissions: z.array(z.string().min(1)),
  restrictions: z.array(z.string().min(1)),
  age_band: z.enum(AGE_BANDS).nullable(),
  parental_controls: z
    .strictObject({
      online_play: z.boolean(),
      in_game_chat: z.boolean(),
      user_generated_content: z.boolean(),
      purchases: z.boolean(),
      daily_playtime_minutes: z.int().min(0).nullable(),
    })
    .nullable(),
  amr: z.array(z.string().min(1)),
  acr: z.string().min(1).nullable(),
  step_up_at: z.iso.datetime().nullable(),
  legal_acceptance_required: z.boolean(),
  expires_at: z.iso.datetime(),
});

export const resolveSessionResponseSchema = z.strictObject({
  session: resolvedSessionSchema.nullable(),
});

export type ResolvedSession = z.output<typeof resolvedSessionSchema>;

export interface ResolveSessionRequest {
  binding_token_hash: string;
  cookie_scope: string;
}

export interface CachedSession {
  session: ResolvedSession;
  cached_at: number;
}

export type EpochKind = 'session' | 'user' | 'all';

export interface SessionCache {
  get: (hash: string) => Promise<CachedSession | null>;
  set: (hash: string, entry: CachedSession, ttl: number) => Promise<void>;
  bump: (kind: EpochKind, id: string, at: number, ttl: number) => Promise<void>;
}

export type SessionResolution =
  | { status: 'none'; stale_cookie: boolean }
  | { status: 'ok'; session: ResolvedSession }
  | { status: 'unavailable' };

export type SessionLookupOutcome =
  'cache_hit' | 'cache_miss' | 'cache_error' | 'not_found' | 'unavailable';

export interface SessionMetrics {
  lookup: (outcome: SessionLookupOutcome) => void;
}

export interface SessionResolverOptions {
  cache: SessionCache;
  resolve: (request: ResolveSessionRequest) => Promise<RpcResult<unknown>>;
  cacheTtl: number;
  metrics: SessionMetrics;
  onError: (message: string, error: unknown) => void;
  now?: () => number;
}

export interface SessionResolver {
  resolve: (token: string, cookieScope: string) => Promise<SessionResolution>;
}

export function sessionCookieName(cookies: CookiesConfig): string {
  return cookies.domain === null ? `__Host-${cookies.name}` : cookies.name;
}

export function readCookie(header: string | null, name: string): string | null {
  if (header === null) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

export function clearSessionCookie(cookies: CookiesConfig): string {
  return [
    `${sessionCookieName(cookies)}=`,
    'Path=/',
    'Max-Age=0',
    ...(cookies.domain === null ? [] : [`Domain=${cookies.domain}`]),
    'Secure',
    'HttpOnly',
    'SameSite=Lax',
  ].join('; ');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

export function isSessionToken(token: string): boolean {
  return TOKEN.test(token);
}

export function prometheusSessionMetrics(metrics: Metrics): SessionMetrics {
  const lookups = metrics.counter({
    name: 'qtiauth_gateway_session_lookups_total',
    help: 'Session cookie lookups, by outcome (cache_hit, cache_miss, cache_error, not_found, unavailable).',
    labelNames: ['outcome'],
  });
  return {
    lookup: (outcome) => {
      lookups.inc({ outcome });
    },
  };
}

export function valkeySessionCache(client: Valkey): SessionCache {
  return {
    get: async (hash) => {
      const raw = await client.get(`${CACHE_PREFIX}${hash}`);
      if (raw === null) return null;
      const entry = JSON.parse(raw) as CachedSession;
      const epochs = await client.mget(
        `${EPOCH_PREFIX}all`,
        `${EPOCH_PREFIX}session:${entry.session.session_id}`,
        `${EPOCH_PREFIX}user:${entry.session.user_id}`,
      );
      if (epochs.some((epoch) => epoch !== null && Number(epoch) >= entry.cached_at)) return null;
      return { session: resolvedSessionSchema.parse(entry.session), cached_at: entry.cached_at };
    },
    set: async (hash, entry, ttl) => {
      await client.set(`${CACHE_PREFIX}${hash}`, JSON.stringify(entry), 'PX', ttl);
    },
    bump: async (kind, id, at, ttl) => {
      const key = kind === 'all' ? `${EPOCH_PREFIX}all` : `${EPOCH_PREFIX}${kind}:${id}`;
      await client.set(key, String(at), 'PX', ttl);
    },
  };
}

export function memorySessionCache(now: () => number = Date.now): SessionCache {
  const entries = new Map<string, { entry: CachedSession; expiresAt: number }>();
  const epochs = new Map<string, { at: number; expiresAt: number }>();
  const epoch = (key: string) => {
    const found = epochs.get(key);
    return found && found.expiresAt > now() ? found.at : null;
  };
  return {
    get: (hash) => {
      const found = entries.get(hash);
      if (!found || found.expiresAt <= now()) return Promise.resolve(null);
      const { entry } = found;
      const bumped = [
        epoch('all'),
        epoch(`session:${entry.session.session_id}`),
        epoch(`user:${entry.session.user_id}`),
      ].some((at) => at !== null && at >= entry.cached_at);
      return Promise.resolve(bumped ? null : structuredClone(entry));
    },
    set: (hash, entry, ttl) => {
      entries.set(hash, { entry: structuredClone(entry), expiresAt: now() + ttl });
      return Promise.resolve();
    },
    bump: (kind, id, at, ttl) => {
      epochs.set(kind === 'all' ? 'all' : `${kind}:${id}`, { at, expiresAt: now() + ttl });
      return Promise.resolve();
    },
  };
}

export function createSessionResolver(options: SessionResolverOptions): SessionResolver {
  const now = options.now ?? Date.now;
  const { cache, metrics } = options;

  return {
    resolve: async (token, cookieScope) => {
      if (!isSessionToken(token)) {
        metrics.lookup('not_found');
        return { status: 'none', stale_cookie: true };
      }
      const hash = hashToken(token);

      let cacheUsable = true;
      try {
        const cached = await cache.get(hash);
        if (cached && Date.parse(cached.session.expires_at) > now()) {
          metrics.lookup('cache_hit');
          return { status: 'ok', session: cached.session };
        }
      } catch (error) {
        cacheUsable = false;
        metrics.lookup('cache_error');
        options.onError('session cache lookup failed', error);
      }

      const startedAt = now();
      const result = await options.resolve({ binding_token_hash: hash, cookie_scope: cookieScope });
      if (result.status !== 'ok') {
        metrics.lookup('unavailable');
        if (result.status === 'error') {
          options.onError(
            'session resolution failed',
            new Error(`${result.code}: ${result.message}`),
          );
        }
        return { status: 'unavailable' };
      }
      const parsed = resolveSessionResponseSchema.safeParse(result.data);
      if (!parsed.success) {
        metrics.lookup('unavailable');
        options.onError('identity returned an invalid session', parsed.error);
        return { status: 'unavailable' };
      }
      const { session } = parsed.data;
      if (session === null || Date.parse(session.expires_at) <= now()) {
        metrics.lookup('not_found');
        return { status: 'none', stale_cookie: true };
      }

      if (cacheUsable) metrics.lookup('cache_miss');
      const ttl = Math.min(options.cacheTtl, Date.parse(session.expires_at) - now());
      if (cacheUsable && ttl > 0) {
        await cache.set(hash, { session, cached_at: startedAt }, ttl).catch((error: unknown) => {
          options.onError('session cache write failed', error);
        });
      }
      return { status: 'ok', session };
    },
  };
}

export const SESSION_EVENTS = [
  'qtiauth.identity.session.revoked.v1',
  'qtiauth.identity.session.flagged.v1',
  'qtiauth.identity.user.updated.v1',
  'qtiauth.identity.user.deleted.v1',
  'qtiauth.identity.user.banned.v1',
  'qtiauth.identity.user.unbanned.v1',
  'qtiauth.identity.user.locked.v1',
  'qtiauth.identity.user.unlocked.v1',
  'qtiauth.identity.user.restricted.v1',
  'qtiauth.identity.user.age_band_changed.v1',
  'qtiauth.identity.parental.consent_granted.v1',
  'qtiauth.identity.parental.consent_revoked.v1',
  'qtiauth.identity.legal.version_published.v1',
] as const;

export function invalidationTargets(event: EventEnvelope): { kind: EpochKind; id: string }[] {
  if (event.type === 'qtiauth.identity.legal.version_published.v1')
    return [{ kind: 'all', id: '' }];
  const targets: { kind: EpochKind; id: string }[] = [];
  if (event.subject?.type === 'user') targets.push({ kind: 'user', id: event.subject.id });
  if (event.subject?.type === 'session') targets.push({ kind: 'session', id: event.subject.id });
  for (const [field, kind] of [
    ['session_id', 'session'],
    ['user_id', 'user'],
  ] as const) {
    const value = event.data[field];
    if (typeof value === 'string' && value !== '') targets.push({ kind, id: value });
  }
  return targets;
}
