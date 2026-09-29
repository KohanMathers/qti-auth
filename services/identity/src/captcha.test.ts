import { sections } from '@qtiauth/config';
import { describe, expect, it } from 'vitest';

import { captchaFromForm, captchaRequired } from './captcha.ts';

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
