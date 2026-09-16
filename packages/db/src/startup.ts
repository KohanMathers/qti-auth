import type { Kysely } from 'kysely';

import { migrate, type MigrateOptions, migrationStatus } from './migrations.ts';

export interface StartupMigrationOptions extends MigrateOptions {
  service: string;
  autoApply: boolean;
}

export function migrateUpCommand(service: string): string {
  return `docker compose run --rm ${service} qtiauth migrate up`;
}

export class PendingMigrationsError extends Error {
  readonly schema: string;
  readonly pending: readonly string[];
  readonly command: string;

  constructor(service: string, schema: string, pending: readonly string[]) {
    const command = migrateUpCommand(service);
    super(
      `Schema ${schema} has ${String(pending.length)} pending migration(s) and migrations.auto_apply is false: ${pending.join(', ')}\nApply them with:\n  ${command}`,
    );
    this.name = 'PendingMigrationsError';
    this.schema = schema;
    this.pending = pending;
    this.command = command;
  }
}

export async function runStartupMigrations(
  db: Kysely<unknown>,
  options: StartupMigrationOptions,
): Promise<string[]> {
  if (options.autoApply) return migrate(db, options);

  const { pending } = await migrationStatus(db, options);
  if (pending.length > 0) {
    throw new PendingMigrationsError(options.service, options.schema, pending);
  }
  return [];
}

export async function runStartupMigrationsOrExit(
  db: Kysely<unknown>,
  options: StartupMigrationOptions,
): Promise<string[]> {
  try {
    return await runStartupMigrations(db, options);
  } catch (error) {
    if (!(error instanceof PendingMigrationsError)) throw error;
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
