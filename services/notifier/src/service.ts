import { join } from 'node:path';

import { loadMigrations } from '@qtiauth/db';
import { createServiceRouter, defineService, type ServiceContext } from '@qtiauth/service-kit';

import packageJson from '../package.json' with { type: 'json' };
import type { Database } from './deliveries.ts';

export const MIGRATIONS_DIR = join(import.meta.dirname, 'migrations');

export const definition = defineService({
  name: 'notifier',
  version: packageJson.version,
  module: 'core',
  sections: ['branding', 'email', 'retention'],
  database: { schema: 'notify', migrations: () => loadMigrations(MIGRATIONS_DIR) },
});

export type Context = ServiceContext<typeof definition, Database>;

export const router = createServiceRouter<Context>(definition);
