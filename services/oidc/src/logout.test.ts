import { describe, expect, it } from 'vitest';

import { LOGOUT_TOKEN_TYPE } from './jwt.ts';
import { LOGOUT_EVENT, logoutRetryDelay, logoutTokenPayload } from './logout.ts';
import { isBlockedAddress, isLoopbackLogoutHost } from './logout-http.ts';

describe('logout tokens', () => {
  it('carry iss, aud, sub, sid, events and jti, and no nonce', () => {
    const payload = logoutTokenPayload({
      issuer: 'https://issuer.example',
      audience: 'game',
      subject: 'user-1',
      sessionId: 'session-1',
      jti: 'delivery-1',
      iat: 1_000,
      exp: 1_900,
    });
    expect(payload).toEqual({
      iss: 'https://issuer.example',
      sub: 'user-1',
      aud: 'game',
      iat: 1_000,
      exp: 1_900,
      jti: 'delivery-1',
      sid: 'session-1',
      events: { [LOGOUT_EVENT]: {} },
    });
    expect(payload).not.toHaveProperty('nonce');
    expect(LOGOUT_TOKEN_TYPE).toBe('logout+jwt');
  });

  it('doubles the retry delay up to the cap', () => {
    const config = {
      timeout: 10_000,
      retry_window: 86_400_000,
      retry_delay: 60_000,
      max_retry_delay: 3_600_000,
      allow_private_targets: false,
    };
    expect(logoutRetryDelay(1, config)).toBe(60_000);
    expect(logoutRetryDelay(2, config)).toBe(120_000);
    expect(logoutRetryDelay(3, config)).toBe(240_000);
    expect(logoutRetryDelay(10, config)).toBe(3_600_000);
  });
});

describe('logout targets', () => {
  it('allows registered loopback hosts and refuses private addresses', () => {
    expect(isLoopbackLogoutHost('127.0.0.1')).toBe(true);
    expect(isLoopbackLogoutHost('::1')).toBe(true);
    expect(isLoopbackLogoutHost('example.com')).toBe(false);
    expect(isBlockedAddress('127.0.0.1')).toBe(true);
    expect(isBlockedAddress('10.0.0.1')).toBe(true);
    expect(isBlockedAddress('8.8.8.8')).toBe(false);
  });
});
