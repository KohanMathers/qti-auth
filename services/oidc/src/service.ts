import { join } from 'node:path';

import { loadMigrations } from '@qtiauth/db';
import {
  createServiceRouter,
  definePermissions,
  defineService,
  type ServiceContext,
} from '@qtiauth/service-kit';

import packageJson from '../package.json' with { type: 'json' };
import { authorizedRoutes } from './authorized.ts';
import type { Database } from './database.ts';
import { discoveryRoutes } from './discovery.ts';
import { OIDC_ERRORS } from './errors.ts';
import { oauthRoutes } from './oauth-routes.ts';
import { consentRoutes, deviceRoutes } from './pages.ts';

export const MIGRATIONS_DIR = join(import.meta.dirname, 'migrations');

export const definition = defineService({
  name: 'oidc',
  version: packageJson.version,
  module: 'oidc',
  sections: ['branding', 'surfaces', 'features', 'oidc', 'retention'],
  database: { schema: 'oidc', migrations: () => loadMigrations(MIGRATIONS_DIR) },
  permissions: definePermissions({
    'oidc.clients.verify': {
      description: 'Mark an OAuth client as verified, which shows a badge on the consent screen',
    },
    'oidc.clients.suspend': {
      description:
        'Suspend an OAuth client, which revokes its tokens and blocks new authorizations',
    },
  }),
  errors: OIDC_ERRORS,
});

export type Context = ServiceContext<typeof definition, Database>;
export type OidcConfig = Context['config'];

export const router = createServiceRouter<Context>(definition);

discoveryRoutes(router);
oauthRoutes(router);
consentRoutes(router);
deviceRoutes(router);
authorizedRoutes(router);
