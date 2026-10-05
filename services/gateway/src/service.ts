import {
  createServiceRouter,
  defineService,
  type OpenApiDocument,
  type ServiceContext,
} from '@qtiauth/service-kit';
import * as z from 'zod';

import packageJson from '../package.json' with { type: 'json' };
import { GATEWAY_ERRORS } from './errors.ts';
import {
  type About,
  aboutHtml,
  aboutSchema,
  type Features,
  featuresSchema,
  type Health,
  healthSchema,
} from './meta.ts';
import type { Surface } from './surfaces.ts';

export const definition = defineService({
  name: 'gateway',
  version: packageJson.version,
  module: 'core',
  sections: [
    'branding',
    'surfaces',
    'cookies',
    'cors',
    'network',
    'features',
    'parental',
    'geoip',
    'session_security',
    'valkey',
    'gateway',
    'rate_limits',
    'security',
    'storage',
  ],
  errors: GATEWAY_ERRORS,
});

export type Context = ServiceContext<typeof definition>;

export interface LocalContext {
  surface: Surface;
  health: () => Health;
  features: () => Features;
  about: () => About;
  openapi: (surface: Surface) => Promise<OpenApiDocument>;
}

export const internalRouter = createServiceRouter<Context>(definition);

export const router = createServiceRouter<LocalContext>(definition);

const noStore = { 'cache-control': 'no-store' };

router.route({
  method: 'GET',
  path: '/api/v1/meta/features',
  operation_id: 'getFeatures',
  summary: 'List enabled modules, auth methods, sub-features, surfaces and branding',
  tags: ['meta'],
  auth: 'none',
  rate_limit: 'global',
  responses: { 200: { description: 'What this deployment offers', schema: featuresSchema } },
  handler: ({ ctx }) =>
    Promise.resolve({ status: 200 as const, body: ctx.features(), headers: noStore }),
});

router.route({
  method: 'GET',
  path: '/api/v1/meta/about',
  operation_id: 'getAbout',
  summary: 'Product name and third-party attribution, including GeoIP',
  tags: ['meta'],
  auth: 'none',
  rate_limit: 'global',
  responses: { 200: { description: 'About this deployment', schema: aboutSchema } },
  handler: ({ ctx }) =>
    Promise.resolve({ status: 200 as const, body: ctx.about(), headers: noStore }),
});

router.route({
  method: 'GET',
  path: '/about',
  operation_id: 'aboutPage',
  summary: 'Attribution for GeoIP and other third-party data',
  tags: ['meta'],
  auth: 'none',
  rate_limit: 'global',
  responses: { 200: { description: 'An HTML about page' } },
  handler: ({ ctx }) =>
    Promise.resolve(
      new Response(aboutHtml(ctx.about()), {
        status: 200,
        headers: { ...noStore, 'content-type': 'text/html; charset=utf-8' },
      }),
    ),
});

router.route({
  method: 'GET',
  path: '/api/v1/meta/health',
  operation_id: 'getHealth',
  summary: 'Check that every service the config needs is running',
  tags: ['meta'],
  auth: 'none',
  rate_limit: 'global',
  responses: { 200: { description: 'Stack health', schema: healthSchema } },
  handler: ({ ctx }) =>
    Promise.resolve({ status: 200 as const, body: ctx.health(), headers: noStore }),
});

router.route({
  method: 'GET',
  path: '/api/v1/openapi.json',
  operation_id: 'getOpenApi',
  summary: 'OpenAPI 3.1 document for every route on this surface',
  tags: ['meta'],
  auth: 'none',
  rate_limit: 'global',
  responses: {
    200: { description: 'The merged OpenAPI document', schema: z.record(z.string(), z.unknown()) },
  },
  handler: async ({ ctx }) => ({
    status: 200 as const,
    body: await ctx.openapi(ctx.surface),
    headers: noStore,
  }),
});
