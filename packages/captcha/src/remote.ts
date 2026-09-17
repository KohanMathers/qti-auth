export const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
export const TURNSTILE_SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
export const HCAPTCHA_VERIFY_URL = 'https://api.hcaptcha.com/siteverify';
export const HCAPTCHA_SCRIPT_URL = 'https://js.hcaptcha.com/1/api.js';
export const FRIENDLY_CAPTCHA_VERIFY_URL = 'https://global.frcapi.com/api/v2/captcha/siteverify';
export const FRIENDLY_CAPTCHA_SCRIPT_URL =
  'https://cdn.jsdelivr.net/npm/@friendlycaptcha/sdk@0.1.26/site.min.js';
export const CAPTCHA_TIMEOUT_MS = 2_000;

export interface RemoteCaptchaSettings {
  siteKey: string;
  secretKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

async function readSuccess(response: Response): Promise<boolean> {
  if (!response.ok) return false;
  const body = (await response.json()) as { success?: unknown };
  return body.success === true;
}

export async function verifyTurnstile(
  payload: string,
  settings: RemoteCaptchaSettings,
  ip: string,
): Promise<boolean> {
  return verifySite(TURNSTILE_VERIFY_URL, payload, settings, ip);
}

export async function verifyHcaptcha(
  payload: string,
  settings: RemoteCaptchaSettings,
  ip: string,
): Promise<boolean> {
  return verifySite(HCAPTCHA_VERIFY_URL, payload, settings, ip);
}

async function verifySite(
  url: string,
  payload: string,
  settings: RemoteCaptchaSettings,
  ip: string,
): Promise<boolean> {
  const fetchImpl = settings.fetch ?? fetch;
  const body = new URLSearchParams({
    secret: settings.secretKey,
    response: payload,
    sitekey: settings.siteKey,
  });
  if (ip !== '') body.set('remoteip', ip);
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(settings.timeoutMs ?? CAPTCHA_TIMEOUT_MS),
    });
    return await readSuccess(response);
  } catch {
    return false;
  }
}

/**
 * Friendly Captcha's siteverify takes no caller IP, so this drops the argument
 * the other vendors' verifiers accept and stays usable in their place.
 */
export async function verifyFriendlyCaptcha(
  payload: string,
  settings: RemoteCaptchaSettings,
): Promise<boolean> {
  const fetchImpl = settings.fetch ?? fetch;
  try {
    const response = await fetchImpl(FRIENDLY_CAPTCHA_VERIFY_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': settings.secretKey,
      },
      body: JSON.stringify({ response: payload, sitekey: settings.siteKey }),
      signal: AbortSignal.timeout(settings.timeoutMs ?? CAPTCHA_TIMEOUT_MS),
    });
    return await readSuccess(response);
  } catch {
    return false;
  }
}
