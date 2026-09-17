import { describe, expect, it } from 'vitest';

import { createRedactor, isRedactedKey, REDACTED } from './redact.ts';

describe('isRedactedKey', () => {
  it('matches secret field names however they are written', () => {
    for (const key of [
      'password',
      'newPassword',
      'client_secret',
      'magic-link-token',
      'refreshToken',
      'Authorization',
      'set-cookie',
      'totp_code',
      'recovery_codes',
      'steam_ticket',
      'report_content',
      'email_body',
      'captcha',
    ]) {
      expect(isRedactedKey(key), key).toBe(true);
    }
  });

  it('leaves ordinary fields alone', () => {
    for (const key of ['user_id', 'code', 'status', 'token_type', 'email', 'route']) {
      expect(isRedactedKey(key), key).toBe(false);
    }
  });
});

describe('createRedactor', () => {
  it('redacts nested values, arrays, maps and error fields', () => {
    const error = Object.assign(new Error('failed'), { token: 'abc', code: 'E1' });
    const redact = createRedactor(['session_code']);
    expect(
      redact({
        body: { password: 'hunter2', items: [{ apiKey: 'k' }], sessionCode: 'x' },
        headers: new Map([['authorization', 'Bearer t']]),
        error,
      }),
    ).toEqual({
      body: { password: REDACTED, items: [{ apiKey: REDACTED }], sessionCode: REDACTED },
      headers: { authorization: REDACTED },
      error: expect.objectContaining({
        type: 'Error',
        message: 'failed',
        token: REDACTED,
        code: 'E1',
      }) as unknown,
    });
  });

  it('handles cycles, deep values, dates, bigints and binary data', () => {
    const cyclic: Record<string, unknown> = { name: 'a' };
    cyclic['self'] = cyclic;
    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let i = 0; i < 20; i++) {
      const next: Record<string, unknown> = {};
      deep['next'] = next;
      deep = next;
    }

    const redacted = createRedactor()({
      cyclic,
      shared: [root, root],
      at: new Date('2026-09-16T12:00:00Z'),
      count: 10n,
      bytes: new Uint8Array([1, 2]),
    }) as Record<string, unknown>;

    expect(redacted['cyclic']).toEqual({ name: 'a', self: '[Circular]' });
    expect(JSON.stringify(redacted['shared'])).toContain('[Truncated]');
    expect(JSON.stringify(redacted['shared'])).not.toContain('[Circular]');
    expect(redacted).toMatchObject({
      at: '2026-09-16T12:00:00.000Z',
      count: '10',
      bytes: '[Binary]',
    });
  });
});
