import {
  type CaptchaProvider,
  type CaptchaWidget,
  createCaptcha,
  FRIENDLY_CAPTCHA_SCRIPT_URL,
  HCAPTCHA_SCRIPT_URL,
  TURNSTILE_SCRIPT_URL,
} from '@qtiauth/captcha';
import { ProblemError } from '@qtiauth/service-kit';

import type { AuthFailureScope } from './database.ts';
import { countedIpAttempts, recordIpAttempt } from './failures.ts';
import { escapeHtml } from './html.ts';
import { identityMetrics } from './metrics.ts';
import type { Context } from './service.ts';
import { clientIp } from './settings.ts';

export const CAPTCHA_ACTIONS = ['password_login', 'password_signup', 'magic_link'] as const;
export type CaptchaAction = (typeof CAPTCHA_ACTIONS)[number];

const ACTION_SCOPE: Record<CaptchaAction, AuthFailureScope> = {
  password_login: 'password',
  password_signup: 'signup',
  magic_link: 'magic_link',
};

const FORM_FIELDS = [
  'captcha',
  'cf-turnstile-response',
  'h-captcha-response',
  'frc-captcha-response',
] as const;

const providers = new WeakMap<object, CaptchaProvider>();

export function captchaProvider(config: Context['config']['captcha']): CaptchaProvider {
  let provider = providers.get(config);
  if (!provider) {
    provider = createCaptcha(config);
    providers.set(config, provider);
  }
  return provider;
}

export function captchaFromForm(form: Record<string, string>): string | undefined {
  for (const name of FORM_FIELDS) {
    const value = form[name];
    if (value !== undefined && value !== '') return value;
  }
  return undefined;
}

export function captchaRequired(attempts: number, config: Context['config']['captcha']): boolean {
  return config.provider !== 'none' && attempts >= config.after;
}

export type CaptchaCheck =
  | { status: 'ok' }
  | { status: 'required'; widget: CaptchaWidget }
  | { status: 'invalid'; widget: CaptchaWidget };

export async function checkCaptcha(
  ctx: Context,
  request: Request,
  action: CaptchaAction,
  payload: string | undefined,
): Promise<CaptchaCheck> {
  const { captcha } = ctx.config;
  if (captcha.provider === 'none') return { status: 'ok' };
  const now = new Date();
  const attempts = await countedIpAttempts(ctx.db, {
    ip: clientIp(request),
    scope: ACTION_SCOPE[action],
    window: captcha.window,
    now,
  });
  if (!captchaRequired(attempts, captcha)) return { status: 'ok' };

  const provider = captchaProvider(captcha);
  const metrics = identityMetrics(ctx.metrics);
  if (payload === undefined || payload === '') {
    metrics.captcha('shown');
    return { status: 'required', widget: provider.issue(now) };
  }
  if (await provider.verify(payload, { ip: clientIp(request), now })) {
    metrics.captcha('solved');
    return { status: 'ok' };
  }
  metrics.captcha('failed');
  return { status: 'invalid', widget: provider.issue(now) };
}

export async function noteCaptchaAttempt(
  ctx: Context,
  request: Request,
  action: CaptchaAction,
): Promise<void> {
  if (ctx.config.captcha.provider === 'none') return;
  await recordIpAttempt(ctx.db, {
    ip: clientIp(request),
    scope: ACTION_SCOPE[action],
    now: new Date(),
  });
}

export function captchaExtensions(widget: CaptchaWidget): Record<string, unknown> {
  return {
    provider: widget.provider,
    ...(widget.site_key === null ? {} : { site_key: widget.site_key }),
    ...(widget.challenge === undefined ? {} : { challenge: widget.challenge }),
  };
}

export function captchaProblem(result: Exclude<CaptchaCheck, { status: 'ok' }>): never {
  throw new ProblemError(result.status === 'invalid' ? 'CAPTCHA_INVALID' : 'CAPTCHA_REQUIRED', {
    extensions: captchaExtensions(result.widget),
  });
}

export async function requireCaptcha(
  ctx: Context,
  request: Request,
  action: CaptchaAction,
  payload: string | undefined,
): Promise<void> {
  const result = await checkCaptcha(ctx, request, action, payload);
  if (result.status !== 'ok') return captchaProblem(result);
}

export async function inspectCaptcha(
  ctx: Context,
  request: Request,
  action: CaptchaAction,
): Promise<{
  required: boolean;
  provider: string;
  site_key: string | null;
  challenge: NonNullable<CaptchaWidget['challenge']> | null;
}> {
  const provider = captchaProvider(ctx.config.captcha);
  const required =
    ctx.config.captcha.provider !== 'none' &&
    captchaRequired(
      await countedIpAttempts(ctx.db, {
        ip: clientIp(request),
        scope: ACTION_SCOPE[action],
        window: ctx.config.captcha.window,
        now: new Date(),
      }),
      ctx.config.captcha,
    );
  if (!required) {
    return {
      required: false,
      provider: provider.name,
      site_key: provider.siteKey,
      challenge: null,
    };
  }
  identityMetrics(ctx.metrics).captcha('shown');
  const widget = provider.issue(new Date());
  return {
    required: true,
    provider: widget.provider,
    site_key: widget.site_key,
    challenge: widget.challenge ?? null,
  };
}

export function captchaMarkup(widget: CaptchaWidget): string {
  switch (widget.provider) {
    case 'none':
      return '';
    case 'altcha': {
      if (widget.challenge === undefined) return '';
      const payload = JSON.stringify(widget.challenge).replaceAll('<', '\\u003c');
      return `<input type="hidden" name="captcha" id="captcha" value="">
<script>
(async () => {
  const challenge = ${payload};
  const encoder = new TextEncoder();
  const hex = (buffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
  for (let n = 0; n <= challenge.maxnumber; n++) {
    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(challenge.salt + String(n)));
    if (hex(digest) === challenge.challenge) {
      document.getElementById('captcha').value = JSON.stringify({ ...challenge, number: n });
      return;
    }
  }
})();
</script>`;
    }
    case 'turnstile':
      return `<div class="cf-turnstile" data-sitekey="${escapeHtml(widget.site_key ?? '')}"></div>
<script src="${TURNSTILE_SCRIPT_URL}" async defer></script>`;
    case 'hcaptcha':
      return `<div class="h-captcha" data-sitekey="${escapeHtml(widget.site_key ?? '')}"></div>
<script src="${HCAPTCHA_SCRIPT_URL}" async defer></script>`;
    case 'friendly_captcha':
      return `<div class="frc-captcha" data-sitekey="${escapeHtml(widget.site_key ?? '')}"></div>
<script type="module" src="${FRIENDLY_CAPTCHA_SCRIPT_URL}" async defer></script>`;
  }
}
