import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { type Kysely, sql } from 'kysely';

export interface Migration {
  name: string;
  up: (db: Kysely<unknown>) => Promise<void>;
}

export interface MigrationPlan {
  applied: string[];
  pending: string[];
  unknown: string[];
}

export interface MigrateOptions {
  schema: string;
  migrations: readonly Migration[];
}

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

export const MIGRATIONS_TABLE = 'schema_migrations';
const LOCK_NAMESPACE = 'qtiauth.migrations';
const MIGRATION_FILE = /^(?!.*\.test\.ts$).+\.ts$/;

export async function loadMigrations(dir: string): Promise<Migration[]> {
  const files = (await readdir(dir)).filter((file) => MIGRATION_FILE.test(file)).sort();
  return Promise.all(
    files.map(async (file) => {
      const module = (await import(pathToFileURL(join(dir, file)).href)) as Partial<Migration>;
      if (typeof module.up !== 'function') {
        throw new MigrationError(`Migration ${file} must export an up function`);
      }
      return { name: file.slice(0, -'.ts'.length), up: module.up };
    }),
  );
}

export function planMigrations(
  migrations: readonly Migration[],
  appliedNames: readonly string[],
): MigrationPlan {
  for (const [i, migration] of migrations.entries()) {
    const previous = migrations[i - 1];
    if (previous && previous.name >= migration.name) {
      throw new MigrationError(
        `Migrations must have unique names in ascending order: ${migration.name} comes after ${previous.name}`,
      );
    }
  }

  const known = new Set(migrations.map((m) => m.name));
  const done = new Set(appliedNames);
  const plan: MigrationPlan = {
    applied: migrations.filter((m) => done.has(m.name)).map((m) => m.name),
    pending: migrations.filter((m) => !done.has(m.name)).map((m) => m.name),
    unknown: appliedNames.filter((name) => !known.has(name)).sort(),
  };

  const latest = [...appliedNames].sort().at(-1);
  const early = plan.pending.find((name) => latest !== undefined && name < latest);
  if (early !== undefined && latest !== undefined) {
    throw new MigrationError(
      `Migration ${early} is pending but sorts before ${latest}, which is already applied. Rename it so it sorts after every applied migration.`,
    );
  }
  return plan;
}

async function appliedMigrations(db: Kysely<unknown>, schema: string): Promise<string[]> {
  const { rows } = await sql<{ name: string }>`
    select name from ${sql.id(schema, MIGRATIONS_TABLE)} order by name
  `
    .execute(db)
    .catch((error: unknown) => {
      if ((error as { code?: string }).code === '42P01') return { rows: [] };
      throw error;
    });
  return rows.map((row) => row.name);
}

export async function migrationStatus(
  db: Kysely<unknown>,
  options: MigrateOptions,
): Promise<MigrationPlan> {
  return planMigrations(options.migrations, await appliedMigrations(db, options.schema));
}

export async function migrate(
  db: Kysely<unknown>,
  options: MigrateOptions & { onApplied?: (name: string) => void },
): Promise<string[]> {
  const { schema, migrations } = options;
  planMigrations(migrations, []);

  return db.connection().execute(async (conn) => {
    const lockKey = sql`hashtext(${LOCK_NAMESPACE}), hashtext(${schema})`;
    await sql`select pg_advisory_lock(${lockKey})`.execute(conn);
    try {
      const { rows } = await sql<{ exists: boolean }>`
        select exists (select 1 from pg_namespace where nspname = ${schema}) as exists
      `.execute(conn);
      if (!rows[0]?.exists) await sql`create schema ${sql.id(schema)}`.execute(conn);
      await sql`
        create table if not exists ${sql.id(schema, MIGRATIONS_TABLE)} (
          name text primary key,
          applied_at timestamptz not null default now()
        )
      `.execute(conn);

      const plan = planMigrations(migrations, await appliedMigrations(conn, schema));
      const pending = migrations.filter((m) => plan.pending.includes(m.name));
      for (const migration of pending) {
        await conn.transaction().execute(async (trx) => {
          await sql`select set_config('search_path', ${schema}, true)`.execute(trx);
          await migration.up(trx);
          await sql`
            insert into ${sql.id(schema, MIGRATIONS_TABLE)} (name) values (${migration.name})
          `.execute(trx);
        });
        options.onApplied?.(migration.name);
      }
      return plan.pending;
    } finally {
      await sql`select pg_advisory_unlock(${lockKey})`.execute(conn);
    }
  });
}
