import { createServiceRouter, defineService, type ServiceContext } from '@qtiauth/service-kit';

import packageJson from '../package.json' with { type: 'json' };

export const definition = defineService({
  name: 'scheduler',
  version: packageJson.version,
  module: 'core',
  sections: ['scheduler'],
});

export type Context = ServiceContext<typeof definition>;

export const router = createServiceRouter<Context>(definition);
