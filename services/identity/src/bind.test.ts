import { sections } from '@qtiauth/config';
import { describe, expect, it, vi } from 'vitest';

import { completeBind, issueBindCode } from './bind.ts';
import { BIND_CODE_TTL, memoryBindStore } from './bind-state.ts';
import { parseBindTarget, surfaceForHost, surfaceUrl } from './settings.ts';

const surfaces = {
  surfaces: sections.surfaces.parse({
    account: { hosts: ['account.example.co.uk'] },
    support: { hosts: ['support.example.com'] },
    api: { hosts: ['auth.example.co.uk'] },
  }),
};

describe('bind codes', () => {
  it('are single-use and bound to the target origin and return path', async () => {
    const store = memoryBindStore();
    const issued = await issueBindCode(store, {
      sessionId: 's1',
      target: 'support',
      origin: 'https://support.example.com',
      returnPath: '/inbox',
    });
    expect(issued.code).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(issued.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const first = await store.take(issued.code);
    expect(first).toMatchObject({
      sessionId: 's1',
      target: 'support',
      origin: 'https://support.example.com',
      returnPath: '/inbox',
    });
    expect(await store.take(issued.code)).toBeUndefined();
  });

  it('expire', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-17T12:00:00Z'));
    const store = memoryBindStore();
    const issued = await issueBindCode(store, {
      sessionId: 's1',
      target: 'support',
      origin: 'https://support.example.com',
      returnPath: '/',
    });
    vi.setSystemTime(new Date(Date.now() + BIND_CODE_TTL + 1));
    expect(await store.take(issued.code)).toBeUndefined();
    vi.useRealTimers();
  });

  it('refuse a code presented on the wrong surface', async () => {
    const store = memoryBindStore();
    const issued = await issueBindCode(store, {
      sessionId: 's1',
      target: 'support',
      origin: 'https://support.example.com',
      returnPath: '/',
    });
    await expect(
      completeBind({} as never, store, {
        code: issued.code,
        target: 'account',
        origin: 'https://account.example.co.uk',
        cookieScope: 'account.example.co.uk',
        idleTimeout: 1,
        now: new Date(),
      }),
    ).resolves.toEqual({ status: 'invalid' });
  });
});

describe('bind target', () => {
  it('needs a known surface, an origin and a path on that surface', () => {
    expect(parseBindTarget(surfaces, 'support', '/inbox')).toEqual({
      target: 'support',
      origin: 'https://support.example.com',
      returnPath: '/inbox',
    });
    expect(parseBindTarget(surfaces, 'nope', '/inbox')).toBeUndefined();
    expect(parseBindTarget(surfaces, 'support', '//evil.example')).toBeUndefined();
    expect(surfaceForHost(surfaces, 'support.example.com')).toBe('support');
    expect(surfaceUrl(surfaces, 'support', '/auth/bind/callback')).toBe(
      'https://support.example.com/auth/bind/callback',
    );
  });
});
