import { join } from 'node:path';

import { loadMigrations } from '@qtiauth/db';
import {
  createServiceRouter,
  definePermissions,
  defineService,
  type ServiceContext,
} from '@qtiauth/service-kit';

import packageJson from '../package.json' with { type: 'json' };
import { authRoutes } from './auth-routes.ts';
import type { Database } from './database.ts';
import { IDENTITY_ERRORS } from './errors.ts';
import { factorRoutes } from './factor-routes.ts';
import { filterRoutes } from './filter-routes.ts';
import { pageRoutes } from './pages.ts';
import { sessionRoutes } from './session-routes.ts';
import { socialRoutes } from './social-routes.ts';

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
    'captcha',
    'email',
    'accounts',
    'magic_link',
    'password',
    'sessions',
    'session_security',
    'geoip',
    'text_filter',
    'age',
    'parental',
    'security',
    'retention',
    'valkey',
  ],
  database: { schema: 'identity', migrations: () => loadMigrations(MIGRATIONS_DIR) },
  permissions: definePermissions({
    'filter.read': {
      description: 'View text-filter decisions, the allowlist and the extra blocklist',
    },
    'filter.manage': { description: 'Change the text-filter allowlist and extra blocklist' },
  }),
  errors: IDENTITY_ERRORS,
});

export type Context = ServiceContext<typeof definition, Database>;
export type IdentityConfig = Context['config'];

export const router = createServiceRouter<Context>(definition);

authRoutes(router);
factorRoutes(router);
socialRoutes(router);
sessionRoutes(router);
filterRoutes(router);
pageRoutes(router);
