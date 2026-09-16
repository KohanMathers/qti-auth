import { type DbSchema, serviceConfigSchema } from '@qtiauth/config';
import { createDb, migrate, type Migration, migrationStatus } from '@qtiauth/db';

import { type CliIo, type Command, CommandExit, EXIT_FAILURE, EXIT_OK } from '../io.ts';
import { configOptionsUsage, loadCommandConfig, parseConfigArgs } from '../options.ts';

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

async function withSchema(
  target: MigrationTarget,
  args: readonly string[],
  io: CliIo,
  usage: string,
  action: (db: Parameters<typeof migrate>[0], migrations: readonly Migration[]) => Promise<void>,
): Promise<number> {
  const values = parseConfigArgs(args, usage);
  if (values.help) {
    io.stdout(usage);
    return EXIT_OK;
  }

  const { config } = await loadCommandConfig(serviceConfigSchema(['database']), values, io);
  const migrations = await target.migrations();
  const db = createDb<unknown>(config.database, target.schema);
  try {
    await action(db, migrations);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new CommandExit(EXIT_FAILURE, `Migrating schema ${target.schema} failed: ${reason}`);
  } finally {
    await db.destroy();
  }
  return EXIT_OK;
}

export function migrateCommands(target: MigrationTarget): Record<string, Command> {
  const { schema } = target;
  return {
    'migrate status': (args, io) =>
      withSchema(target, args, io, statusUsage, async (db, migrations) => {
        const plan = await migrationStatus(db, { schema, migrations });
        const lines = [
          `Schema ${schema}: ${String(plan.applied.length)} applied, ${String(plan.pending.length)} pending`,
          ...plan.applied.map((name) => `  applied  ${name}`),
          ...plan.pending.map((name) => `  pending  ${name}`),
          ...plan.unknown.map((name) => `  unknown  ${name} (applied by a newer release)`),
        ];
        io.stdout(`${lines.join('\n')}\n`);
      }),
    'migrate up': (args, io) =>
      withSchema(target, args, io, upUsage, async (db, migrations) => {
        await migrate(db, {
          schema,
          migrations,
          onApplied: (name) => {
            io.stdout(`Applied ${name}\n`);
          },
        });
        io.stdout(`Schema ${schema} is up to date.\n`);
      }),
  };
}
