import { join } from 'node:path';

import { loadMigrations } from '@qtiauth/db';
import {
  createServiceRouter,
  definePermissions,
  defineService,
  type ServiceContext,
} from '@qtiauth/service-kit';

import packageJson from '../package.json' with { type: 'json' };
import { adminUserRoutes } from './admin-user-routes.ts';
import { ageRoutes } from './age-routes.ts';
import { auditRoutes } from './audit-routes.ts';
import { authRoutes } from './auth-routes.ts';
import type { Database } from './database.ts';
import { IDENTITY_ERRORS } from './errors.ts';
import { factorRoutes } from './factor-routes.ts';
import { filterRoutes } from './filter-routes.ts';
import { legalRoutes } from './legal-routes.ts';
import { lifecycleRoutes } from './lifecycle-routes.ts';
import { pageRoutes } from './pages.ts';
import { roleRoutes } from './role-routes.ts';
import { sessionRoutes } from './session-routes.ts';
import { socialRoutes } from './social-routes.ts';
import { usernameRoutes } from './username-routes.ts';

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
    'usernames',
    'legal',
    'security',
    'roles',
    'retention',
    'valkey',
    'storage',
    'backups',
  ],
  database: { schema: 'identity', migrations: () => loadMigrations(MIGRATIONS_DIR) },
  permissions: definePermissions({
    'filter.read': {
      description: 'View text-filter decisions, the allowlist and the extra blocklist',
    },
    'filter.manage': { description: 'Change the text-filter allowlist and extra blocklist' },
    'users.edit_dob': { description: 'Change a user’s date of birth' },
    'users.read': { description: 'Search and view accounts' },
    'users.ban': { description: 'Ban and unban accounts' },
    'users.lock': {
      description: 'Lock and unlock accounts, force re-authentication and revoke sessions',
    },
    'users.force_username_reset': { description: 'Force a user to choose a new username' },
    'roles.manage': { description: 'Create, edit and assign roles' },
    'audit.read': { description: 'Read the audit log' },
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
usernameRoutes(router);
ageRoutes(router);
adminUserRoutes(router);
roleRoutes(router);
auditRoutes(router);
legalRoutes(router);
lifecycleRoutes(router);
pageRoutes(router);
