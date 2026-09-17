import { sections } from '@qtiauth/config';
import { describe, expect, it } from 'vitest';

import { captchaFromForm, captchaMarkup, captchaRequired } from './captcha.ts';

describe('captchaRequired', () => {
  it('starts after the configured number of attempts and never with provider none', () => {
    const altcha = sections.captcha.parse({ after: 3 });
    expect(captchaRequired(0, altcha)).toBe(false);
    expect(captchaRequired(2, altcha)).toBe(false);
    expect(captchaRequired(3, altcha)).toBe(true);
    expect(captchaRequired(0, sections.captcha.parse({ after: 0 }))).toBe(true);
    expect(captchaRequired(9, sections.captcha.parse({ provider: 'none', after: 0 }))).toBe(false);
  });
});

describe('captchaFromForm', () => {
  it('reads the first filled CAPTCHA field', () => {
    expect(captchaFromForm({ email: 'a@example.com' })).toBeUndefined();
    expect(captchaFromForm({ captcha: 'token' })).toBe('token');
    expect(captchaFromForm({ 'cf-turnstile-response': 'cf', captcha: '' })).toBe('cf');
  });
});

describe('captchaMarkup', () => {
  it('embeds an Altcha solver and vendor widgets', () => {
    const altcha = captchaMarkup({
      provider: 'altcha',
      site_key: null,
      challenge: {
        algorithm: 'SHA-256',
        challenge: 'abc',
        salt: 'salt?expires=1',
        signature: 'sig',
        maxnumber: 10,
      },
    });
    expect(altcha).toContain('name="captcha"');
    expect(altcha).toContain('maxnumber');
    expect(captchaMarkup({ provider: 'none', site_key: null })).toBe('');
    expect(captchaMarkup({ provider: 'turnstile', site_key: 'site' })).toContain('cf-turnstile');
  });
});
