import { createServiceRouter, defineService, type ServiceContext } from '@qtiauth/service-kit';
import * as z from 'zod';

import packageJson from '../package.json' with { type: 'json' };

export const definition = defineService({
  name: 'template',
  version: packageJson.version,
  module: 'core',
});

export type Context = ServiceContext<typeof definition>;

export const router = createServiceRouter<Context>(definition);

router.route({
  method: 'GET',
  path: '/api/v1/template/hello',
  operation_id: 'hello',
  summary: 'Say hello to the signed-in user',
  auth: 'session',
  rate_limit: 'global',
  responses: {
    200: { description: 'A greeting', schema: z.object({ message: z.string() }) },
  },
  handler: ({ ctx }) =>
    Promise.resolve({ status: 200 as const, body: { message: `Hello from ${ctx.service}` } }),
});
