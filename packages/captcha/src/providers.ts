import { randomBytes } from 'node:crypto';

import type { CaptchaProviderName, QtiauthConfig } from '@qtiauth/config';

import { createAltchaChallenge, verifyAltcha } from './altcha.ts';
import { verifyFriendlyCaptcha, verifyHcaptcha, verifyTurnstile } from './remote.ts';

export type CaptchaConfig = QtiauthConfig['captcha'];

export interface CaptchaWidget {
  provider: CaptchaProviderName;
  site_key: string | null;
  challenge?: ReturnType<typeof createAltchaChallenge>;
}

export interface CaptchaProvider {
  name: CaptchaProviderName;
  siteKey: string | null;
  issue: (now: Date) => CaptchaWidget;
  verify: (payload: string, options: { ip: string; now: Date }) => Promise<boolean>;
}

export interface CaptchaOptions {
  fetch?: typeof fetch;
}

function hmacKey(configured: string): string {
  return configured === '' ? randomBytes(32).toString('base64') : configured;
}

function noneProvider(): CaptchaProvider {
  return {
    name: 'none',
    siteKey: null,
    issue: () => ({ provider: 'none', site_key: null }),
    verify: () => Promise.resolve(true),
  };
}

function altchaProvider(config: CaptchaConfig): CaptchaProvider {
  const settings = {
    hmacKey: hmacKey(config.altcha.hmac_key),
    maxNumber: config.altcha.max_number,
    expires: config.altcha.expires,
  };
  return {
    name: 'altcha',
    siteKey: null,
    issue: (now) => ({
      provider: 'altcha',
      site_key: null,
      challenge: createAltchaChallenge(settings, now),
    }),
    verify: (payload, { now }) => Promise.resolve(verifyAltcha(payload, settings, now)),
  };
}

function vendor(
  name: 'turnstile' | 'hcaptcha' | 'friendly_captcha',
  config: CaptchaConfig,
  options: CaptchaOptions,
  verify: (
    payload: string,
    settings: { siteKey: string; secretKey: string; fetch?: typeof fetch },
    ip: string,
  ) => Promise<boolean>,
): CaptchaProvider {
  const vendorConfig = config[name];
  const settings = {
    siteKey: vendorConfig.site_key,
    secretKey: vendorConfig.secret_key,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  };
  return {
    name,
    siteKey: vendorConfig.site_key,
    issue: () => ({ provider: name, site_key: vendorConfig.site_key }),
    verify: (payload, { ip }) => verify(payload, settings, ip),
  };
}

export function createCaptcha(
  config: CaptchaConfig,
  options: CaptchaOptions = {},
): CaptchaProvider {
  switch (config.provider) {
    case 'none':
      return noneProvider();
    case 'altcha':
      return altchaProvider(config);
    case 'turnstile':
      return vendor('turnstile', config, options, verifyTurnstile);
    case 'hcaptcha':
      return vendor('hcaptcha', config, options, verifyHcaptcha);
    case 'friendly_captcha':
      return vendor('friendly_captcha', config, options, (payload, settings) =>
        verifyFriendlyCaptcha(payload, settings),
      );
  }
}
