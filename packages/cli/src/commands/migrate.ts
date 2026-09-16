import { type DbSchema, serviceConfigSchema } from '@qtiauth/config';
import { createDb, migrate, type Migration, migrationStatus } from '@qtiauth/db';

import { configCommand } from '../command.ts';
import { type Command, CommandExit, EXIT_FAILURE, EXIT_OK } from '../io.ts';
import { configOptionsUsage } from '../options.ts';

export interface MigrationTarget {
  schema: DbSchema;
  migrations: () => Promise<readonly Migration[]>;
}

const statusUsage = `Usage: qtiauth migrate status [--config <path>] [--env-file <path>]

Lists this service's applied and pending database migrations.

Options:
${configOptionsUsage}
`;

const upUsage = `Usage: qtiauth migrate up [--config <path>] [--env-file <path>]

Applies this service's pending database migrations. Safe to run while other replicas start: migrations are applied once, under a lock.

Options:
${configOptionsUsage}
`;

function withSchema(
  target: MigrationTarget,
  usage: string,
  action: (
    db: Parameters<typeof migrate>[0],
    migrations: readonly Migration[],
    write: (text: string) => void,
  ) => Promise<void>,
): Command {
  return configCommand({
    usage,
    schema: serviceConfigSchema(['database']),
    run: async ({ config, io }) => {
      const migrations = await target.migrations();
      const db = createDb<unknown>(config.database, target.schema);
      try {
        await action(db, migrations, io.stdout);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new CommandExit(EXIT_FAILURE, `Migrating schema ${target.schema} failed: ${reason}`);
      } finally {
        await db.destroy();
      }
      return EXIT_OK;
    },
  });
}

export function migrateCommands(target: MigrationTarget): Record<string, Command> {
  const { schema } = target;
  return {
    'migrate status': withSchema(target, statusUsage, async (db, migrations, write) => {
      const plan = await migrationStatus(db, { schema, migrations });
      const lines = [
        `Schema ${schema}: ${String(plan.applied.length)} applied, ${String(plan.pending.length)} pending`,
        ...plan.applied.map((name) => `  applied  ${name}`),
        ...plan.pending.map((name) => `  pending  ${name}`),
        ...plan.unknown.map((name) => `  unknown  ${name} (applied by a newer release)`),
      ];
      write(`${lines.join('\n')}\n`);
    }),
    'migrate up': withSchema(target, upUsage, async (db, migrations, write) => {
      await migrate(db, {
        schema,
        migrations,
        onApplied: (name) => {
          write(`Applied ${name}\n`);
        },
      });
      write(`Schema ${schema} is up to date.\n`);
    }),
  };
}
