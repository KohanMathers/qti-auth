import { DB_SCHEMAS, serviceConfigSchema } from '@qtiauth/config';
import { createAdminDb, provisionRoles } from '@qtiauth/db';

import { configCommand } from '../command.ts';
import { CommandExit, EXIT_FAILURE, EXIT_OK } from '../io.ts';
import { configOptionsUsage } from '../options.ts';

export const ADMIN_USER_ENV = 'POSTGRES_USER';
export const ADMIN_PASSWORD_ENV = 'POSTGRES_PASSWORD';

export const usage = `Usage: qtiauth db provision [--config <path>] [--env-file <path>]

Creates or updates one Postgres role and schema per service (database.roles), so each service can only use its own schema. Connects as an administrator using $${ADMIN_USER_ENV} (default postgres) and $${ADMIN_PASSWORD_ENV}. Safe to run again, for example after changing a role's password.

Options:
${configOptionsUsage}
`;

export const dbProvision = configCommand({
  usage,
  schema: serviceConfigSchema(['database']),
  run: async ({ config, env, io }) => {
    const password = env[ADMIN_PASSWORD_ENV];
    if (!password) {
      throw new CommandExit(
        EXIT_FAILURE,
        `Set ${ADMIN_PASSWORD_ENV} to the administrator password`,
      );
    }

    const admin = createAdminDb(config.database, {
      user: env[ADMIN_USER_ENV] ?? 'postgres',
      password,
    });
    try {
      await provisionRoles(admin, config.database);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new CommandExit(EXIT_FAILURE, `Provisioning failed: ${reason}`);
    } finally {
      await admin.destroy();
    }

    io.stdout(`Provisioned roles and schemas: ${DB_SCHEMAS.join(', ')}\n`);
    return EXIT_OK;
  },
});
