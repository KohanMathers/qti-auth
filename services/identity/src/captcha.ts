import { type CaptchaProvider, type CaptchaWidget, createCaptcha } from '@qtiauth/captcha';
import { ProblemError } from '@qtiauth/service-kit';

import type { AuthFailureScope } from './database.ts';
import { countedIpAttempts, recordIpAttempt } from './failures.ts';
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

async function captchaIsRequired(
  ctx: Context,
  request: Request,
  action: CaptchaAction,
  now: Date,
): Promise<boolean> {
  const { captcha } = ctx.config;
  if (captcha.provider === 'none') return false;
  const attempts = await countedIpAttempts(ctx.db, {
    ip: clientIp(request),
    scope: ACTION_SCOPE[action],
    window: captcha.window,
    now,
  });
  return captchaRequired(attempts, captcha);
}

export async function checkCaptcha(
  ctx: Context,
  request: Request,
  action: CaptchaAction,
  payload: string | undefined,
): Promise<CaptchaCheck> {
  const { captcha } = ctx.config;
  const now = new Date();
  if (!(await captchaIsRequired(ctx, request, action, now))) return { status: 'ok' };

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
  const now = new Date();
  const provider = captchaProvider(ctx.config.captcha);
  if (!(await captchaIsRequired(ctx, request, action, now))) {
    return {
      required: false,
      provider: provider.name,
      site_key: provider.siteKey,
      challenge: null,
    };
  }
  identityMetrics(ctx.metrics).captcha('shown');
  const widget = provider.issue(now);
  return {
    required: true,
    provider: widget.provider,
    site_key: widget.site_key,
    challenge: widget.challenge ?? null,
  };
}
