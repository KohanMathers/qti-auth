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
import { SUPPORT_ERRORS } from './errors.ts';
import { guestRoutes } from './guest-routes.ts';
import { ticketRoutes } from './routes.ts';
import { staffRoutes } from './staff-routes.ts';

export const MIGRATIONS_DIR = join(import.meta.dirname, 'migrations');

export const definition = defineService({
  name: 'support',
  version: packageJson.version,
  module: 'support',
  sections: [
    'branding',
    'surfaces',
    'features',
    'support',
    'retention',
    'email',
    'captcha',
    'accounts',
    'storage',
  ],
  database: { schema: 'support', migrations: () => loadMigrations(MIGRATIONS_DIR) },
  permissions: definePermissions({
    'support.tickets.staff': {
      description: 'Read and answer every ticket',
    },
  }),
  notifications: defineNotificationCategories({
    'support.ticket_updates': {
      description: 'Replies and status changes on your support tickets',
    },
    'support.new_tickets': {
      description: 'A new support ticket was opened',
      audience: 'staff',
    },
  }),
  errors: SUPPORT_ERRORS,
});

export type Context = ServiceContext<typeof definition, Database>;
export type SupportConfig = Context['config'];

export const router = createServiceRouter<Context>(definition);

ticketRoutes(router);
guestRoutes(router);
staffRoutes(router);
