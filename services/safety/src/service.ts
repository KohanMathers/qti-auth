import { join } from 'node:path';

import { loadMigrations } from '@qtiauth/db';
import {
  createServiceRouter,
  definePermissions,
  defineService,
  type ServiceContext,
} from '@qtiauth/service-kit';

import packageJson from '../package.json' with { type: 'json' };
import type { Database } from './database.ts';
import { SAFETY_ERRORS } from './errors.ts';
import { moderationRoutes } from './moderation-routes.ts';
import { intakeRoutes } from './routes.ts';

export const MIGRATIONS_DIR = join(import.meta.dirname, 'migrations');

export const definition = defineService({
  name: 'safety',
  version: packageJson.version,
  module: 'safety',
  sections: ['branding', 'surfaces', 'features', 'safety', 'retention', 'email'],
  database: { schema: 'safety', migrations: () => loadMigrations(MIGRATIONS_DIR) },
  permissions: definePermissions({
    'safety.reports.read': {
      description: 'Read safety reports, including snapshots, in the moderation queue',
    },
    'safety.reports.submit': {
      description: 'Submit safety reports and flags through the service intake API',
    },
    'safety.actions.apply': {
      description: 'Apply moderation actions such as warnings, restrictions, locks and bans',
    },
  }),
  errors: SAFETY_ERRORS,
});

export type Context = ServiceContext<typeof definition, Database>;
export type SafetyConfig = Context['config'];

export const router = createServiceRouter<Context>(definition);

intakeRoutes(router);
moderationRoutes(router);
