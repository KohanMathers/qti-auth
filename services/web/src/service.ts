import {
  createServiceRouter,
  defineService,
  ProblemError,
  type ServiceContext,
} from '@qtiauth/service-kit';
import * as z from 'zod';

import packageJson from '../package.json' with { type: 'json' };
import { assetResponse } from './assets.ts';
import { PAGES } from './assets/pages.js';
import { makeLoadContext } from './data.ts';
import { WEB_ERRORS } from './errors.ts';
import { catalogueFor, resolveLocale, translatorFor } from './i18n.ts';
import { localeResponse } from './locale.ts';
import { renderPage } from './render.ts';
import { shellResponse } from './shell.ts';
import { themeResponse } from './theme.ts';
import { requireWebState, type WebState } from './web-state.ts';

export const definition = defineService({
  name: 'web',
  version: packageJson.version,
  module: 'core',
  sections: ['branding', 'surfaces', 'cookies'],
  errors: WEB_ERRORS,
});

export type Context = ServiceContext<typeof definition>;

export const router = createServiceRouter<Context>(definition);

const htmlOk = { 200: { description: 'A rendered page' } };
const cssOk = { 200: { description: 'A stylesheet' } };
const jsOk = { 200: { description: 'A JavaScript asset' } };
const jsonOk = { 200: { description: 'A JSON catalogue' } };
const redirectOk = { 303: { description: 'Redirect to the referrer' } };

const THEME_COOKIE = 'qtiauth_theme';
const LOCALE_COOKIE = 'qtiauth_locale';
const THEME_VALUES = new Set(['light', 'dark', 'system']);
const THEME_PATTERN = new RegExp(`(?:^|;\\s*)${THEME_COOKIE}=([^;]+)`);

function themePreference(request: Request): 'light' | 'dark' | 'system' | undefined {
  const header = request.headers.get('cookie');
  if (header === null) return undefined;
  const match = THEME_PATTERN.exec(header);
  if (match === null) return undefined;
  const value = decodeURIComponent(match[1] ?? '').trim();
  if (!THEME_VALUES.has(value)) return undefined;
  return value === 'system' ? undefined : (value as 'light' | 'dark');
}

async function renderShell(
  ctx: Context,
  request: Request,
  pageName: string,
  params: Record<string, string>,
): Promise<Response> {
  const state = requireWebState(ctx);
  const locale = resolveLocale({ request, locales: state.locales });
  const catalogue = catalogueFor(state.locales, locale);
  const t = translatorFor(catalogue);
  const loadCtx = makeLoadContext(request, ctx.config, params);
  const content = await renderPage({ name: pageName, ctx: loadCtx, t });
  return shellResponse(ctx.config, {
    basePath: state.basePath,
    metaOrigin: state.metaOrigin,
    content,
    locale,
    theme: themePreference(request),
  });
}

function operationId(pageId: string): string {
  return `page${pageId.replaceAll(/(?:^|-)([a-z])/g, (_, letter: string) => letter.toUpperCase())}`;
}

function nameFromPath(path: string): string {
  if (path === '/') return 'account';
  const [, head] = path.split('/');
  return head ?? 'account';
}

const PUBLIC_PAGES = new Set<string>([
  'sign-in',
  'sign-up',
  'forgot',
  'reset',
  'verify',
  'magic-link',
  'confirm-email',
  'revert-email',
  'methods',
  'device',
  'waiting',
  'social-callback',
  'legal',
  'legal-document',
  'support',
  'support-kb',
  'support-kb-article',
  'support-kb-category',
  'support-kb-search',
  'support-guest',
  'support-guest-verify',
  'support-guest-view',
  'guardian-approve',
  'guardian-decline',
  'family-invite',
  'report',
]);

const SESSION_COOKIE_PATTERN = /(?:^|;\s*)(?:__Host-)?qtiauth_session=([^;]+)/;

function hasSessionCookie(request: Request): boolean {
  const header = request.headers.get('cookie');
  return header !== null && SESSION_COOKIE_PATTERN.test(header);
}

function requestHost(request: Request): string | null {
  const header = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  if (header === null) return null;
  const match = /^(\[[0-9a-fA-F:.]+\]|[^:]+)(?::\d+)?$/.exec(header.trim());
  return match?.[1]?.toLowerCase() ?? null;
}

function rootPageIdFor(request: Request, ctx: Context): string {
  const host = requestHost(request);
  if (host !== null) {
    const support = ctx.config.surfaces.support;
    if (support?.hosts.map((h) => h.toLowerCase()).includes(host)) return 'support';
  }
  return 'account';
}

function signInRedirect(basePath: string, returnTo: string): Response {
  const base = basePath === '/' ? '' : basePath;
  const target = `${base}/sign-in?return_to=${encodeURIComponent(returnTo)}`;
  return new Response(null, {
    status: 303,
    headers: { location: target, 'cache-control': 'no-store' },
  });
}

function gateOrRender(
  ctx: Context,
  request: Request,
  pageId: string,
  params: Record<string, string>,
  returnTo: string,
): Promise<Response> {
  if (!PUBLIC_PAGES.has(pageId) && !hasSessionCookie(request)) {
    const basePath = requireWebState(ctx).basePath;
    return Promise.resolve(signInRedirect(basePath, returnTo));
  }
  return renderShell(ctx, request, pageId, params);
}

router.route({
  method: 'GET',
  path: '/',
  operation_id: 'appShell',
  summary: 'Render the account landing page',
  tags: ['web'],
  auth: 'none',
  rate_limit: 'global',
  responses: htmlOk,
  handler: ({ ctx, request }) => {
    const rootPageId = rootPageIdFor(request, ctx);
    return gateOrRender(ctx, request, rootPageId, {}, '/');
  },
});

for (const [id, page] of Object.entries(PAGES)) {
  if (page.path === '/') continue;
  const names = [...page.path.matchAll(/:([a-z_]+)/g)].map((match) => match[1] ?? '');
  router.route({
    method: 'GET',
    path: page.path,
    operation_id: operationId(id),
    summary: `Render the ${id} page`,
    tags: ['web'],
    auth: 'none',
    rate_limit: 'global',
    ...(names.length === 0
      ? {}
      : {
          request: {
            params: z.object(Object.fromEntries(names.map((name) => [name, z.string().max(256)]))),
          },
        }),
    responses: htmlOk,
    handler: ({ ctx, request, params }) => {
      const resolved = (params ?? {}) as Record<string, string>;
      const url = new URL(request.url);
      return gateOrRender(ctx, request, id, resolved, `${url.pathname}${url.search}`);
    },
  });
}

router.route({
  method: 'GET',
  path: '/theme.css',
  operation_id: 'themeStylesheet',
  summary: 'CSS custom properties for branding-driven theming',
  tags: ['web'],
  auth: 'none',
  rate_limit: 'global',
  responses: cssOk,
  handler: ({ ctx }) => Promise.resolve(themeResponse(ctx.config)),
});

router.route({
  method: 'GET',
  path: '/styles.css',
  operation_id: 'appStylesheet',
  summary: 'Base stylesheet for the web app shell',
  tags: ['web'],
  auth: 'none',
  rate_limit: 'global',
  responses: cssOk,
  errors: ['ASSET_NOT_FOUND'],
  handler: ({ ctx, request }) =>
    Promise.resolve(serveAsset(requireWebState(ctx), request, 'styles.css')),
});

router.route({
  method: 'GET',
  path: '/app.js',
  operation_id: 'appScript',
  summary: 'Progressive-enhancement script for toggles, dialogs and async forms',
  tags: ['web'],
  auth: 'none',
  rate_limit: 'global',
  responses: jsOk,
  errors: ['ASSET_NOT_FOUND'],
  handler: ({ ctx, request }) =>
    Promise.resolve(serveAsset(requireWebState(ctx), request, 'app.js')),
});

router.route({
  method: 'GET',
  path: '/problems.js',
  operation_id: 'problemsScript',
  summary: 'Problem Details code to message catalogue',
  tags: ['web'],
  auth: 'none',
  rate_limit: 'global',
  responses: jsOk,
  errors: ['ASSET_NOT_FOUND'],
  handler: ({ ctx, request }) =>
    Promise.resolve(serveAsset(requireWebState(ctx), request, 'problems.js')),
});

router.route({
  method: 'GET',
  path: '/client.js',
  operation_id: 'clientScript',
  summary: 'Typed API client for the account surface',
  tags: ['web'],
  auth: 'none',
  rate_limit: 'global',
  responses: jsOk,
  errors: ['ASSET_NOT_FOUND'],
  handler: ({ ctx, request }) =>
    Promise.resolve(serveAsset(requireWebState(ctx), request, 'client.js')),
});

router.route({
  method: 'GET',
  path: '/pages.js',
  operation_id: 'pagesScript',
  summary: 'Page registry for the account surface',
  tags: ['web'],
  auth: 'none',
  rate_limit: 'global',
  responses: jsOk,
  errors: ['ASSET_NOT_FOUND'],
  handler: ({ ctx, request }) =>
    Promise.resolve(serveAsset(requireWebState(ctx), request, 'pages.js')),
});

router.route({
  method: 'GET',
  path: '/view.js',
  operation_id: 'viewScript',
  summary: 'Template engine that fills page templates',
  tags: ['web'],
  auth: 'none',
  rate_limit: 'global',
  responses: jsOk,
  errors: ['ASSET_NOT_FOUND'],
  handler: ({ ctx, request }) =>
    Promise.resolve(serveAsset(requireWebState(ctx), request, 'view.js')),
});

router.route({
  method: 'GET',
  path: '/templates.html',
  operation_id: 'pageTemplates',
  summary: 'Every page template, bundled from assets/pages',
  tags: ['web'],
  auth: 'none',
  rate_limit: 'global',
  responses: { 200: { description: 'The page template bundle' } },
  handler: ({ ctx, request }) =>
    Promise.resolve(assetResponse(requireWebState(ctx).templates, request)),
});

router.route({
  method: 'GET',
  path: '/locales/:locale',
  operation_id: 'localeCatalogue',
  summary: 'Translated strings for a locale',
  tags: ['web'],
  auth: 'none',
  rate_limit: 'global',
  request: { params: z.object({ locale: z.string().min(1).max(32) }) },
  responses: jsonOk,
  errors: ['LOCALE_NOT_AVAILABLE'],
  handler: ({ ctx, params }) => {
    const response = localeResponse(requireWebState(ctx).locales, params.locale);
    if (response === undefined) {
      throw new ProblemError('LOCALE_NOT_AVAILABLE', {
        detail: `No catalogue for ${params.locale}`,
      });
    }
    return Promise.resolve(response);
  },
});

router.route({
  method: 'POST',
  path: '/theme',
  operation_id: 'setTheme',
  summary: 'Store the user colour-scheme preference',
  tags: ['web'],
  auth: 'none',
  rate_limit: 'global',
  request: {
    body: z.object({
      theme: z.enum(['light', 'dark', 'system']),
      return_to: z.string().max(2048).optional(),
    }),
  },
  responses: redirectOk,
  handler: ({ body, request }) => Promise.resolve(setPreferenceCookie(THEME_COOKIE, body.theme, body.return_to, request)),
});

router.route({
  method: 'POST',
  path: '/locale',
  operation_id: 'setLocale',
  summary: 'Store the user locale preference',
  tags: ['web'],
  auth: 'none',
  rate_limit: 'global',
  request: {
    body: z.object({
      locale: z.string().min(1).max(32),
      return_to: z.string().max(2048).optional(),
    }),
  },
  responses: redirectOk,
  handler: ({ body, ctx, request }) => {
    const state = requireWebState(ctx);
    if (!state.locales.has(body.locale)) {
      throw new ProblemError('LOCALE_NOT_AVAILABLE', { detail: `No catalogue for ${body.locale}` });
    }
    return Promise.resolve(setPreferenceCookie(LOCALE_COOKIE, body.locale, body.return_to, request));
  },
});

const SAFE_RETURN = /^\/(?![/\\])[^\s\\]*$/u;

function sanitiseReturn(value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  if (value.length > 2048) return fallback;
  return SAFE_RETURN.test(value) ? value : fallback;
}

function setPreferenceCookie(
  name: string,
  value: string,
  returnTo: string | undefined,
  request: Request,
): Response {
  const referer = request.headers.get('referer');
  let fallback = '/';
  if (referer !== null) {
    try {
      fallback = new URL(referer).pathname;
    } catch {
      fallback = '/';
    }
  }
  const target = sanitiseReturn(returnTo, fallback);
  const cookie = `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=31536000; SameSite=Lax`;
  return new Response(null, {
    status: 303,
    headers: {
      location: target,
      'set-cookie': cookie,
      'cache-control': 'no-store',
    },
  });
}

function serveAsset(state: WebState, request: Request, name: string): Response {
  const asset = state.assets.get(name);
  if (asset === undefined) {
    throw new ProblemError('ASSET_NOT_FOUND', { detail: `No asset named ${name}` });
  }
  return assetResponse(asset, request);
}

export { nameFromPath };
