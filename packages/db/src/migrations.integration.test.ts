import { sections } from '@qtiauth/config';
import { startPostgres } from '@qtiauth/testing';
import { type Kysely, type RawBuilder, sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDb, type DatabaseConfig } from './connect.ts';
import { type Migration, migrationStatus } from './migrations.ts';
import { PendingMigrationsError, runStartupMigrations } from './startup.ts';

let container: Awaited<ReturnType<typeof startPostgres>>;
let database: DatabaseConfig;
const replicas: Kysely<unknown>[] = [];

function replica(): Kysely<unknown> {
  const db = createDb<unknown>(database, 'identity');
  replicas.push(db);
  return db;
}

function migration(name: string, ...queries: RawBuilder<unknown>[]): Migration {
  return {
    name,
    up: async (db) => {
      for (const query of queries) await query.execute(db);
    },
  };
}

async function tables(db: Kysely<unknown>, schema: string): Promise<string[]> {
  const { rows } = await sql<{ tablename: string }>`
    select tablename from pg_tables where schemaname = ${schema} order by tablename
  `.execute(db);
  return rows.map((row) => row.tablename);
}

beforeAll(async () => {
  container = await startPostgres();
  database = sections.database.parse({
    host: container.getHost(),
    port: container.getPort(),
    name: container.getDatabase(),
    roles: { identity: { user: container.getUsername(), password: container.getPassword() } },
  });
});

afterAll(async () => {
  await Promise.all(replicas.map((db) => db.destroy()));
  await container.stop();
});

describe('migrations', () => {
  it('applies migrations exactly once when two replicas start at once', async () => {
    const calls: string[] = [];
    const migrations: Migration[] = [
      {
        name: '0001_create_runs',
        up: async (db) => {
          calls.push('0001_create_runs');
          await sql`create table runs (name text not null)`.execute(db);
          await sql`select pg_sleep(0.3)`.execute(db);
          await sql`insert into runs values ('first')`.execute(db);
        },
      },
      {
        name: '0002_insert_run',
        up: async (db) => {
          calls.push('0002_insert_run');
          await sql`insert into runs values ('second')`.execute(db);
        },
      },
    ];
    const options = { service: 'identity', schema: 'replicas', migrations, autoApply: true };

    const [first, second] = [replica(), replica()];
    const results = await Promise.all([
      runStartupMigrations(first, options),
      runStartupMigrations(second, options),
    ]);

    expect(calls).toEqual(['0001_create_runs', '0002_insert_run']);
    expect(results.flat()).toEqual(['0001_create_runs', '0002_insert_run']);
    const { rows } = await sql<{ name: string }>`select name from replicas.runs`.execute(first);
    expect(rows.map((row) => row.name)).toEqual(['first', 'second']);
    expect(await migrationStatus(second, options)).toEqual({
      applied: ['0001_create_runs', '0002_insert_run'],
      pending: [],
      unknown: [],
    });
  });

  it('rolls back a failed migration and stops there', async () => {
    const db = replica();
    const migrations: Migration[] = [
      migration('0001_ok', sql`create table ok (id int)`),
      migration('0002_broken', sql`create table half_done (id int)`, sql`select * from missing`),
      migration('0003_never', sql`create table never (id int)`),
    ];
    const options = { service: 'identity', schema: 'failing', migrations, autoApply: true };

    await expect(runStartupMigrations(db, options)).rejects.toThrow('missing');
    expect(await migrationStatus(db, options)).toEqual({
      applied: ['0001_ok'],
      pending: ['0002_broken', '0003_never'],
      unknown: [],
    });
    expect(await tables(db, 'failing')).toEqual(['ok', 'schema_migrations']);
  });

  it('refuses to start with pending migrations when auto_apply is false', async () => {
    const db = replica();
    const migrations = [migration('0001_a', sql`create table a (id int)`)];
    const options = { service: 'identity', schema: 'manual', migrations, autoApply: false };

    expect(await migrationStatus(db, options)).toEqual({
      applied: [],
      pending: ['0001_a'],
      unknown: [],
    });
    const error: unknown = await runStartupMigrations(db, options).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PendingMigrationsError);
    expect((error as PendingMigrationsError).command).toBe(
      'docker compose run --rm identity qtiauth migrate up',
    );
    expect(await tables(db, 'manual')).toEqual([]);

    await runStartupMigrations(db, { ...options, autoApply: true });
    await expect(runStartupMigrations(db, options)).resolves.toEqual([]);
  });

  it('lets the previous release start against a newer schema', async () => {
    const db = replica();
    const migrations = [
      migration('0001_a', sql`create table a (id int)`),
      migration('0002_b', sql`alter table a add column b int`),
    ];
    const options = { service: 'identity', schema: 'rollback', migrations, autoApply: true };
    await runStartupMigrations(db, options);

    const previous = { ...options, migrations: migrations.slice(0, 1), autoApply: false };
    await expect(runStartupMigrations(db, previous)).resolves.toEqual([]);
    expect(await migrationStatus(db, previous)).toEqual({
      applied: ['0001_a'],
      pending: [],
      unknown: ['0002_b'],
    });
  });
});
