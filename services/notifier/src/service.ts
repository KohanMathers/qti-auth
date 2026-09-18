import { join } from 'node:path';

import { loadMigrations } from '@qtiauth/db';
import {
  createServiceRouter,
  defineNotificationCategories,
  definePermissions,
  defineService,
  type ServiceContext,
} from '@qtiauth/service-kit';

import packageJson from '../package.json' with { type: 'json' };
import type { Database } from './database.ts';
import { NOTIFIER_ERRORS } from './errors.ts';
import { webhookRoutes } from './webhook-routes.ts';

export const MIGRATIONS_DIR = join(import.meta.dirname, 'migrations');

export const definition = defineService({
  name: 'notifier',
  version: packageJson.version,
  module: 'core',
  sections: ['branding', 'surfaces', 'email', 'webhooks', 'retention'],
  database: { schema: 'notify', migrations: () => loadMigrations(MIGRATIONS_DIR) },
  permissions: definePermissions({
    'webhooks.manage': { description: 'Create, edit and test outbound webhook endpoints' },
  }),
  notifications: defineNotificationCategories({
    'webhooks.endpoint_disabled': {
      description: 'An outbound webhook endpoint was disabled after consecutive failures',
      audience: 'staff',
    },
  }),
  errors: NOTIFIER_ERRORS,
});

export type Context = ServiceContext<typeof definition, Database>;

export const router = createServiceRouter<Context>(definition);

webhookRoutes(router);
