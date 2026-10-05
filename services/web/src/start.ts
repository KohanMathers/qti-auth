import { type StartServiceOptions, type Stoppable, unwind } from '@qtiauth/service-kit';

import { type AssetSet, DEFAULT_ASSETS_DIR, loadAssets } from './assets.ts';
import { DEFAULT_LOCALE, DEFAULT_LOCALES_DIR, type LocaleSet, loadLocales } from './locale.ts';
import { assertKitCoverage } from './problems.ts';
import { type Context, type definition, router } from './service.ts';
import { DEFAULT_TEMPLATES_DIR, loadTemplates } from './templates.ts';
import { attachWebState } from './web-state.ts';

export const REQUIRED_ASSETS = [
  'app.js',
  'captcha.js',
  'client.js',
  'pages.js',
  'problems.js',
  'styles.css',
  'view.js',
] as const;

export class WebStartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebStartError';
  }
}

export interface WebOptions {
  assetsDir?: string;
  templatesDir?: string;
  localesDir?: string;
  metaOrigin?: string;
}

function assertAssets(assets: AssetSet): void {
  const missing = REQUIRED_ASSETS.filter((name) => !assets.has(name));
  if (missing.length > 0) {
    throw new WebStartError(`Web assets missing: ${missing.sort().join(', ')}`);
  }
}

function assertLocales(locales: LocaleSet): void {
  if (!locales.has(DEFAULT_LOCALE)) {
    throw new WebStartError(`Locale ${DEFAULT_LOCALE} must be shipped`);
  }
}

function basePathFor(ctx: Context): string {
  const account = ctx.config.surfaces.account;
  return account.base_path;
}

function metaOriginFor(ctx: Context, override: string | undefined): string | undefined {
  if (override !== undefined) return override;
  const account = ctx.config.surfaces.account;
  return account.origins?.[0] ?? (account.hosts[0] && `https://${account.hosts[0]}`);
}

export function webService(options: WebOptions = {}) {
  return {
    router,
    start: async (ctx: Context) => {
      const { log } = ctx;
      const stack: Stoppable[] = [];
      try {
        assertKitCoverage();
        const assets = await loadAssets(options.assetsDir ?? DEFAULT_ASSETS_DIR);
        assertAssets(assets);
        const templates = await loadTemplates(options.templatesDir ?? DEFAULT_TEMPLATES_DIR);
        const locales = await loadLocales(options.localesDir ?? DEFAULT_LOCALES_DIR);
        assertLocales(locales);
        attachWebState(ctx, {
          assets,
          templates,
          locales,
          basePath: basePathFor(ctx),
          metaOrigin: metaOriginFor(ctx, options.metaOrigin),
        });
        log.info('web started', {
          assets: [...assets.keys()].sort(),
          locales: [...locales.keys()].sort(),
          base_path: basePathFor(ctx),
        });
        return stack;
      } catch (error) {
        await unwind(stack.splice(0).map((task) => () => task.stop())).catch(
          (cleanupError: unknown) => {
            log.error('cleanup after failed start also failed', { error: cleanupError });
          },
        );
        throw error;
      }
    },
  } satisfies StartServiceOptions<typeof definition, unknown>;
}
