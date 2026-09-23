import { type CaptchaProvider, type CaptchaWidget, createCaptcha } from '@qtiauth/captcha';
import { ProblemError } from '@qtiauth/service-kit';

import { countedGuestAttempts } from './guest.ts';
import type { Context } from './service.ts';

const providers = new WeakMap<object, CaptchaProvider>();

export function captchaProvider(config: Context['config']['captcha']): CaptchaProvider {
  let provider = providers.get(config);
  if (!provider) {
    provider = createCaptcha(config);
    providers.set(config, provider);
  }
  return provider;
}

export function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded === null) return '';
  return forwarded.split(',')[0]?.trim() ?? '';
}

export function captchaRequired(attempts: number, config: Context['config']['captcha']): boolean {
  return config.provider !== 'none' && attempts >= config.after;
}

export type CaptchaCheck =
  | { status: 'ok' }
  | { status: 'required'; widget: CaptchaWidget }
  | { status: 'invalid'; widget: CaptchaWidget };

async function captchaIsRequired(ctx: Context, request: Request, now: Date): Promise<boolean> {
  const { captcha } = ctx.config;
  if (captcha.provider === 'none') return false;
  const attempts = await countedGuestAttempts(ctx.db, {
    ip: clientIp(request),
    window: captcha.window,
    now,
  });
  return captchaRequired(attempts, captcha);
}

export async function checkCaptcha(
  ctx: Context,
  request: Request,
  payload: string | undefined,
): Promise<CaptchaCheck> {
  const now = new Date();
  if (!(await captchaIsRequired(ctx, request, now))) return { status: 'ok' };
  const provider = captchaProvider(ctx.config.captcha);
  if (payload === undefined || payload === '') {
    return { status: 'required', widget: provider.issue(now) };
  }
  if (await provider.verify(payload, { ip: clientIp(request), now })) return { status: 'ok' };
  return { status: 'invalid', widget: provider.issue(now) };
}

export function captchaExtensions(widget: CaptchaWidget): Record<string, unknown> {
  return {
    provider: widget.provider,
    ...(widget.site_key === null ? {} : { site_key: widget.site_key }),
    ...(widget.challenge === undefined ? {} : { challenge: widget.challenge }),
  };
}

export function captchaProblem(result: Exclude<CaptchaCheck, { status: 'ok' }>): never {
  throw new ProblemError(
    result.status === 'invalid' ? 'SUPPORT_CAPTCHA_INVALID' : 'SUPPORT_CAPTCHA_REQUIRED',
    { extensions: captchaExtensions(result.widget) },
  );
}

export async function requireCaptcha(
  ctx: Context,
  request: Request,
  payload: string | undefined,
): Promise<void> {
  const result = await checkCaptcha(ctx, request, payload);
  if (result.status !== 'ok') return captchaProblem(result);
}

export async function inspectCaptcha(
  ctx: Context,
  request: Request,
): Promise<{
  required: boolean;
  provider: string;
  site_key: string | null;
  challenge: NonNullable<CaptchaWidget['challenge']> | null;
}> {
  const now = new Date();
  const provider = captchaProvider(ctx.config.captcha);
  if (!(await captchaIsRequired(ctx, request, now))) {
    return {
      required: false,
      provider: provider.name,
      site_key: provider.siteKey,
      challenge: null,
    };
  }
  const widget = provider.issue(now);
  return {
    required: true,
    provider: widget.provider,
    site_key: widget.site_key,
    challenge: widget.challenge ?? null,
  };
}
