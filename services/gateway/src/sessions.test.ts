import { randomBytes } from 'node:crypto';

import type { RpcResult } from '@qtiauth/bus';
import { sections } from '@qtiauth/config';
import { newEventId } from '@qtiauth/events';
import {
  hashSessionToken,
  type ResolvedSession,
  type ResolveSessionRequest,
} from '@qtiauth/service-kit';
import { describe, expect, it, vi } from 'vitest';

import {
  clearFamilyCookie,
  clearSessionCookie,
  createSessionResolver,
  familyCookieName,
  invalidationTargets,
  memorySessionCache,
  readCookie,
  type SessionCache,
  sessionCookieName,
  signalsMatch,
} from './sessions.ts';

const START = Date.parse('2026-09-17T12:00:00Z');
const token = randomBytes(32).toString('base64url');

function session(overrides: Partial<ResolvedSession> = {}): ResolvedSession {
  return {
    session_id: 's1',
    user_id: 'u1',
    account_state: 'active',
    permissions: [],
    restrictions: [],
    age_band: 'adult',
    parental_controls: null,
    amr: ['email'],
    acr: 'aal1',
    step_up_at: null,
    legal_acceptance_required: false,
    two_factor_enrolment_required: false,
    expires_at: new Date(START + 86_400_000).toISOString(),
    ...overrides,
  };
}

function setup(options: { cache?: SessionCache; reply?: () => RpcResult<unknown> } = {}) {
  let at = START;
  const now = () => at;
  const cache = options.cache ?? memorySessionCache(now);
  const outcomes: string[] = [];
  const onError = vi.fn();
  const rpc = vi.fn<(request: ResolveSessionRequest) => Promise<RpcResult<unknown>>>(() =>
    Promise.resolve(options.reply?.() ?? { status: 'ok', data: { session: session() } }),
  );
  const resolver = createSessionResolver({
    cache,
    resolve: rpc,
    cacheTtl: 60_000,
    metrics: { lookup: (outcome) => outcomes.push(outcome) },
    onError,
    now,
  });
  return {
    resolver,
    cache,
    rpc,
    outcomes,
    onError,
    advance: (ms: number) => {
      at += ms;
    },
    now,
  };
}

describe('cookies', () => {
  it('uses the __Host- prefix without a shared domain', () => {
    const cookies = sections.cookies.parse({});
    expect(sessionCookieName(cookies)).toBe('__Host-qtiauth_session');
    expect(clearSessionCookie(cookies)).toBe(
      '__Host-qtiauth_session=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax',
    );
    expect(familyCookieName(cookies)).toBe('__Host-qtiauth_session_family');
    expect(clearFamilyCookie(cookies)).toBe(
      '__Host-qtiauth_session_family=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax',
    );
    const shared = sections.cookies.parse({ domain: 'example.com' });
    expect(sessionCookieName(shared)).toBe('qtiauth_session');
    expect(clearSessionCookie(shared)).toContain('Domain=example.com');
  });

  it('reads one cookie from the header', () => {
    expect(readCookie('a=1; __Host-qtiauth_session=abc; b=2', '__Host-qtiauth_session')).toBe(
      'abc',
    );
    expect(readCookie('qtiauth_session=abc', '__Host-qtiauth_session')).toBeNull();
    expect(readCookie(null, 'x')).toBeNull();
  });
});

describe('signalsMatch', () => {
  const signals = (
    overrides: Partial<NonNullable<ResolveSessionRequest['signals']>> = {},
  ): NonNullable<ResolveSessionRequest['signals']> => ({
    ip: '203.0.113.10',
    user_agent: 'Firefox',
    country: 'GB',
    tls_fingerprint: null,
    timezone: 'Europe/London',
    screen: '1920x1080',
    client_fingerprint: null,
    ...overrides,
  });

  it('matches when nothing was captured or nothing is being sent', () => {
    expect(signalsMatch(undefined, signals())).toBe(true);
    expect(signalsMatch(null, signals())).toBe(true);
    expect(signalsMatch(signals(), undefined)).toBe(true);
  });

  it('keeps the cache for another address in the same subnet', () => {
    expect(signalsMatch(signals(), signals({ ip: '203.0.113.40' }))).toBe(true);
  });

  it('drops the cache for another subnet, country or client', () => {
    expect(signalsMatch(signals(), signals({ ip: '198.51.100.7' }))).toBe(false);
    expect(signalsMatch(signals(), signals({ country: 'US' }))).toBe(false);
    expect(signalsMatch(signals(), signals({ user_agent: 'Safari' }))).toBe(false);
    expect(signalsMatch(signals(), signals({ timezone: 'America/New_York' }))).toBe(false);
  });

  it('does not depend on key order', () => {
    const cached = { ...signals() };
    const current = {
      client_fingerprint: null,
      screen: '1920x1080',
      timezone: 'Europe/London',
      tls_fingerprint: null,
      country: 'GB',
      user_agent: 'Firefox',
      ip: '203.0.113.10',
    };
    expect(signalsMatch(cached, current)).toBe(true);
  });
});

describe('createSessionResolver', () => {
  it('asks identity with the hashed token, then serves from the cache', async () => {
    const { resolver, rpc, outcomes } = setup();
    expect(await resolver.resolve(token, 'me.example.com')).toEqual({
      status: 'ok',
      session: session(),
    });
    expect(rpc).toHaveBeenCalledExactlyOnceWith({
      binding_token_hash: hashSessionToken(token),
      cookie_scope: 'me.example.com',
    });
    expect(JSON.stringify(rpc.mock.calls)).not.toContain(token);

    expect((await resolver.resolve(token, 'me.example.com')).status).toBe('ok');
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(outcomes).toEqual(['cache_miss', 'cache_hit']);
  });

  it('asks identity again when the request signals change', async () => {
    const { resolver, rpc } = setup();
    const gb = {
      ip: '203.0.113.10',
      user_agent: 'Firefox',
      country: 'GB',
      tls_fingerprint: null,
      timezone: null,
      screen: null,
      client_fingerprint: null,
    };
    await resolver.resolve(token, 'me.example.com', gb);
    await resolver.resolve(token, 'me.example.com', { ...gb, country: 'US' });
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('stops using the cache when the session, user or everything is invalidated', async () => {
    const { resolver, cache, rpc, advance, now } = setup();
    await resolver.resolve(token, 'me.example.com');
    for (const [kind, id] of [
      ['session', 's1'],
      ['user', 'u1'],
      ['all', ''],
    ] as const) {
      advance(10);
      await cache.bump(kind, id, now(), 120_000);
      advance(10);
      const calls = rpc.mock.calls.length;
      await resolver.resolve(token, 'me.example.com');
      await resolver.resolve(token, 'me.example.com');
      expect(rpc.mock.calls.length).toBe(calls + 1);
    }
  });

  it('never caches a session resolved before a concurrent invalidation', async () => {
    let bumpDuringLookup: (() => Promise<void>) | undefined;
    const cache = memorySessionCache(() => START);
    const { resolver, rpc } = setup({
      cache,
      reply: () => {
        void bumpDuringLookup?.();
        return { status: 'ok', data: { session: session() } };
      },
    });
    bumpDuringLookup = () => cache.bump('session', 's1', START, 120_000);
    await resolver.resolve(token, 'me.example.com');
    bumpDuringLookup = undefined;
    await resolver.resolve(token, 'me.example.com');
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('reports unknown, malformed and expired tokens as signed out', async () => {
    const unknown = setup({ reply: () => ({ status: 'ok', data: { session: null } }) });
    expect(await unknown.resolver.resolve(token, 'x')).toEqual({
      status: 'none',
      stale_cookie: true,
    });

    const malformed = setup();
    expect(await malformed.resolver.resolve('short', 'x')).toEqual({
      status: 'none',
      stale_cookie: true,
    });
    expect(malformed.rpc).not.toHaveBeenCalled();

    const expired = setup({
      reply: () => ({
        status: 'ok',
        data: { session: session({ expires_at: new Date(START - 1).toISOString() }) },
      }),
    });
    expect((await expired.resolver.resolve(token, 'x')).status).toBe('none');
  });

  it('is unavailable when identity is not running or answers nonsense', async () => {
    for (const reply of [
      () => ({ status: 'no_responders' }) as const,
      () => ({ status: 'timeout' }) as const,
      () => ({ status: 'error', code: 'internal', message: 'boom' }) as const,
      () => ({ status: 'ok', data: { session: { user_id: 'u1' } } }) as const,
    ]) {
      const { resolver } = setup({ reply });
      expect(await resolver.resolve(token, 'x')).toEqual({ status: 'unavailable' });
    }
  });

  it('falls back to identity when the cache is down', async () => {
    const broken: SessionCache = {
      get: () => Promise.reject(new Error('valkey down')),
      set: () => Promise.reject(new Error('valkey down')),
      bump: () => Promise.reject(new Error('valkey down')),
    };
    const { resolver, outcomes, onError } = setup({ cache: broken });
    expect((await resolver.resolve(token, 'x')).status).toBe('ok');
    expect(outcomes).toEqual(['cache_error']);
    expect(onError).toHaveBeenCalledWith('session cache lookup failed', expect.any(Error));
  });
});

describe('invalidationTargets', () => {
  const event = (type: string, subject: { type: string; id: string } | null, data = {}) => ({
    event_id: newEventId(),
    type,
    occurred_at: new Date(START).toISOString(),
    actor: { type: 'system' as const, id: 'identity' },
    subject,
    data,
    trace_id: null,
    span_id: null,
  });

  it('maps events to the sessions and users they affect', () => {
    expect(
      invalidationTargets(event('qtiauth.identity.user.banned.v1', { type: 'user', id: 'u1' })),
    ).toEqual([{ kind: 'user', id: 'u1' }]);
    expect(
      invalidationTargets(
        event(
          'qtiauth.identity.session.revoked.v1',
          { type: 'user', id: 'u1' },
          { session_id: 's1' },
        ),
      ),
    ).toEqual([
      { kind: 'user', id: 'u1' },
      { kind: 'session', id: 's1' },
    ]);
    expect(invalidationTargets(event('qtiauth.identity.legal.version_published.v1', null))).toEqual(
      [{ kind: 'all', id: '' }],
    );
  });
});
