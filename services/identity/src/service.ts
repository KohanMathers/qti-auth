import { join } from 'node:path';

import { loadMigrations } from '@qtiauth/db';
import { createServiceRouter, defineService, type ServiceContext } from '@qtiauth/service-kit';

import packageJson from '../package.json' with { type: 'json' };
import { authRoutes } from './auth-routes.ts';
import type { Database } from './database.ts';
import { IDENTITY_ERRORS } from './errors.ts';
import { pageRoutes } from './pages.ts';
import { sessionRoutes } from './session-routes.ts';

export const MIGRATIONS_DIR = join(import.meta.dirname, 'migrations');

export const definition = defineService({
  name: 'identity',
  version: packageJson.version,
  module: 'core',
  sections: [
    'branding',
    'surfaces',
    'cookies',
    'features',
    'email',
    'accounts',
    'magic_link',
    'password',
    'sessions',
    'age',
    'parental',
    'security',
    'retention',
  ],
  database: { schema: 'identity', migrations: () => loadMigrations(MIGRATIONS_DIR) },
  errors: IDENTITY_ERRORS,
});

export type Context = ServiceContext<typeof definition, Database>;
export type IdentityConfig = Context['config'];

export const router = createServiceRouter<Context>(definition);

authRoutes(router);
sessionRoutes(router);
pageRoutes(router);
