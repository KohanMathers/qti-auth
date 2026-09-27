import { type CaptchaProvider, type CaptchaWidget, createCaptcha } from '@qtiauth/captcha';
import { ProblemError } from '@qtiauth/service-kit';
import { type Kysely, sql } from 'kysely';

import type { Database } from './database.ts';
import { gamesMetrics } from './metrics.ts';
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

export async function countedRedeemAttempts(
  db: Kysely<Database>,
  options: { ip: string; window: number; now: Date },
): Promise<number> {
  const row = await db
    .selectFrom('key_redeem_attempts')
    .select(['attempts', 'updated_at'])
    .where('ip', '=', options.ip)
    .executeTakeFirst();
  if (row === undefined) return 0;
  if (options.now.getTime() - row.updated_at.getTime() > options.window) return 0;
  return row.attempts;
}

export async function recordRedeemAttempt(
  db: Kysely<Database>,
  options: { ip: string; now: Date },
): Promise<void> {
  await db
    .insertInto('key_redeem_attempts')
    .values({ ip: options.ip, attempts: 1, updated_at: options.now })
    .onConflict((conflict) =>
      conflict.column('ip').doUpdateSet({
        attempts: sql`key_redeem_attempts.attempts + 1`,
        updated_at: options.now,
      }),
    )
    .execute();
}

export async function clearRedeemAttempts(db: Kysely<Database>, ip: string): Promise<void> {
  await db.deleteFrom('key_redeem_attempts').where('ip', '=', ip).execute();
}

async function captchaIsRequired(ctx: Context, request: Request, now: Date): Promise<boolean> {
  const { captcha } = ctx.config;
  if (captcha.provider === 'none') return false;
  const attempts = await countedRedeemAttempts(ctx.db, {
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
  const metrics = gamesMetrics(ctx.metrics);
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

export function captchaExtensions(widget: CaptchaWidget): Record<string, unknown> {
  return {
    provider: widget.provider,
    ...(widget.site_key === null ? {} : { site_key: widget.site_key }),
    ...(widget.challenge === undefined ? {} : { challenge: widget.challenge }),
  };
}

export function captchaProblem(result: Exclude<CaptchaCheck, { status: 'ok' }>): never {
  throw new ProblemError(
    result.status === 'invalid' ? 'GAMES_CAPTCHA_INVALID' : 'GAMES_CAPTCHA_REQUIRED',
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
  gamesMetrics(ctx.metrics).captcha('shown');
  const widget = provider.issue(now);
  return {
    required: true,
    provider: widget.provider,
    site_key: widget.site_key,
    challenge: widget.challenge ?? null,
  };
}
