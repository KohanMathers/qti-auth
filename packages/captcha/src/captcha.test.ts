import { sections } from '@qtiauth/config';
import { describe, expect, it, vi } from 'vitest';

import { createAltchaChallenge, solveAltcha, verifyAltcha } from './altcha.ts';
import { createCaptcha } from './providers.ts';
import {
  FRIENDLY_CAPTCHA_VERIFY_URL,
  HCAPTCHA_VERIFY_URL,
  TURNSTILE_VERIFY_URL,
} from './remote.ts';

const hmacKey = 'test-hmac-key';
const settings = { hmacKey, maxNumber: 200, expires: 120_000 };

function altchaConfig(overrides: Record<string, unknown> = {}) {
  return sections.captcha.parse({
    provider: 'altcha',
    altcha: { hmac_key: hmacKey, max_number: 200 },
    ...overrides,
  });
}

describe('altcha', () => {
  it('issues a challenge that verifies when solved and not when tampered with', () => {
    const now = new Date('2026-09-17T12:00:00Z');
    const challenge = createAltchaChallenge(settings, now);
    const payload = solveAltcha(challenge);
    expect(verifyAltcha(payload, settings, now)).toBe(true);
    expect(verifyAltcha(Buffer.from(payload).toString('base64url'), settings, now)).toBe(true);
    expect(verifyAltcha(payload, { ...settings, hmacKey: 'other' }, now)).toBe(false);
    expect(verifyAltcha('not-a-payload', settings, now)).toBe(false);

    const parsed = JSON.parse(payload) as { number: number };
    parsed.number = parsed.number === 0 ? 1 : 0;
    expect(verifyAltcha(JSON.stringify(parsed), settings, now)).toBe(false);

    const expired = new Date(now.getTime() + settings.expires + 1);
    expect(verifyAltcha(payload, settings, expired)).toBe(false);
  });
});

describe('createCaptcha', () => {
  it('never requires work when the provider is none', async () => {
    const captcha = createCaptcha(sections.captcha.parse({ provider: 'none' }));
    expect(captcha.name).toBe('none');
    expect(captcha.issue(new Date()).site_key).toBeNull();
    expect(await captcha.verify('', { ip: '203.0.113.1', now: new Date() })).toBe(true);
  });

  it('creates Altcha challenges that the same instance accepts', async () => {
    const captcha = createCaptcha(altchaConfig());
    const now = new Date();
    const widget = captcha.issue(now);
    expect(widget.provider).toBe('altcha');
    expect(widget.challenge).toEqual(expect.objectContaining({ algorithm: 'SHA-256' }));
    if (widget.challenge === undefined) throw new Error('expected an Altcha challenge');
    const payload = solveAltcha(widget.challenge);
    expect(await captcha.verify(payload, { ip: '', now })).toBe(true);
    expect(await captcha.verify('nope', { ip: '', now })).toBe(false);
  });

  it('asks Turnstile, hCaptcha and Friendly Captcha and fails closed', async () => {
    const fetchImpl = vi.fn((input: string | URL) => {
      expect([TURNSTILE_VERIFY_URL, HCAPTCHA_VERIFY_URL, FRIENDLY_CAPTCHA_VERIFY_URL]).toContain(
        String(input),
      );
      return Promise.resolve(new Response(JSON.stringify({ success: true })));
    }) as typeof fetch;

    for (const provider of ['turnstile', 'hcaptcha', 'friendly_captcha'] as const) {
      const captcha = createCaptcha(
        sections.captcha.parse({
          provider,
          [provider]: { site_key: 'site', secret_key: 'secret' },
        }),
        { fetch: fetchImpl },
      );
      expect(captcha.issue(new Date())).toEqual({ provider, site_key: 'site' });
      expect(await captcha.verify('token', { ip: '203.0.113.9', now: new Date() })).toBe(true);
    }

    const down = vi.fn(() => Promise.reject(new Error('offline'))) as typeof fetch;
    const captcha = createCaptcha(
      sections.captcha.parse({
        provider: 'turnstile',
        turnstile: { site_key: 'site', secret_key: 'secret' },
      }),
      { fetch: down },
    );
    expect(await captcha.verify('token', { ip: '', now: new Date() })).toBe(false);
  });
});
