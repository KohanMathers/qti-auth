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
import { WEB_ERRORS } from './errors.ts';
import { localeResponse } from './locale.ts';
import { shellResponse } from './shell.ts';
import { themeResponse } from './theme.ts';
import { requireWebState, type WebState } from './web-state.ts';

export const definition = defineService({
  name: 'web',
  version: packageJson.version,
  module: 'core',
  sections: ['branding', 'surfaces'],
  errors: WEB_ERRORS,
});

export type Context = ServiceContext<typeof definition>;

export const router = createServiceRouter<Context>(definition);

const htmlOk = { 200: { description: 'The app shell' } };
const cssOk = { 200: { description: 'A stylesheet' } };
const jsOk = { 200: { description: 'A JavaScript asset' } };
const jsonOk = { 200: { description: 'A JSON catalogue' } };

function appShell(ctx: Context): Promise<Response> {
  const state = requireWebState(ctx);
  return Promise.resolve(
    shellResponse(ctx.config, { basePath: state.basePath, metaOrigin: state.metaOrigin }),
  );
}

router.route({
  method: 'GET',
  path: '/',
  operation_id: 'appShell',
  summary: 'Render the vanilla web app shell',
  tags: ['web'],
  auth: 'none',
  rate_limit: 'global',
  responses: htmlOk,
  handler: ({ ctx }) => appShell(ctx),
});

function operationId(pageId: string): string {
  return `page${pageId.replaceAll(/(?:^|-)([a-z])/g, (_, letter: string) => letter.toUpperCase())}`;
}

for (const [id, page] of Object.entries(PAGES)) {
  if (page.path === '/') continue;
  const names = [...page.path.matchAll(/:([a-z_]+)/g)].map((match) => match[1] ?? '');
  router.route({
    method: 'GET',
    path: page.path,
    operation_id: operationId(id),
    summary: `Render the web app shell for the ${id} page`,
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
    handler: ({ ctx }) => appShell(ctx),
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
  summary: 'Client-side router and bootstrap',
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

function serveAsset(state: WebState, request: Request, name: string): Response {
  const asset = state.assets.get(name);
  if (asset === undefined) {
    throw new ProblemError('ASSET_NOT_FOUND', { detail: `No asset named ${name}` });
  }
  return assetResponse(asset, request);
}
