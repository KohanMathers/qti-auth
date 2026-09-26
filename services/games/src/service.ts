import { join } from 'node:path';

import { loadMigrations } from '@qtiauth/db';
import {
  createServiceRouter,
  definePermissions,
  defineService,
  type ServiceContext,
} from '@qtiauth/service-kit';

import packageJson from '../package.json' with { type: 'json' };
import { adminRoutes } from './admin-routes.ts';
import type { Database } from './database.ts';
import { GAMES_ERRORS } from './errors.ts';
import { routes } from './routes.ts';

export const MIGRATIONS_DIR = join(import.meta.dirname, 'migrations');

export const definition = defineService({
  name: 'games',
  version: packageJson.version,
  module: 'games',
  sections: ['branding', 'surfaces', 'features', 'games', 'retention'],
  database: { schema: 'games', migrations: () => loadMigrations(MIGRATIONS_DIR) },
  permissions: definePermissions({
    'games.catalog.manage': {
      description: 'Create, edit and delete games and their products',
    },
    'games.entitlements.manage': {
      description: 'Grant and revoke game entitlements from the admin UI',
    },
  }),
  errors: GAMES_ERRORS,
});

export type Context = ServiceContext<typeof definition, Database>;
export type GamesConfig = Context['config'];

export const router = createServiceRouter<Context>(definition);

routes(router);
adminRoutes(router);
