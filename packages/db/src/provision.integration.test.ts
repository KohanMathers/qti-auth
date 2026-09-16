import { DB_SCHEMAS, sections } from '@qtiauth/config';
import { startPostgres } from '@qtiauth/testing';
import { type Kysely, sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createAdminDb, createDb, type DatabaseConfig } from './connect.ts';
import { migrate } from './migrations.ts';
import { provisionRoles } from './provision.ts';

let container: Awaited<ReturnType<typeof startPostgres>>;
let database: DatabaseConfig;
let admin: Kysely<unknown>;
let identity: Kysely<unknown>;
let notify: Kysely<unknown>;

function errorCode(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => (error as { code?: string }).code,
  );
}

beforeAll(async () => {
  container = await startPostgres();
  database = sections.database.parse({
    host: container.getHost(),
    port: container.getPort(),
    name: container.getDatabase(),
    roles: Object.fromEntries(
      DB_SCHEMAS.map((schema) => [schema, { password: `${schema}-password` }]),
    ),
  });
  admin = createAdminDb(database, {
    user: container.getUsername(),
    password: container.getPassword(),
  });
  await provisionRoles(admin, database);
  identity = createDb(database, 'identity');
  notify = createDb(database, 'notify');
});

afterAll(async () => {
  await Promise.all([admin.destroy(), identity.destroy(), notify.destroy()]);
  await container.stop();
});

describe('provisionRoles', () => {
  it('creates one unprivileged role owning each schema', async () => {
    const { rows } = await sql<{ schema: string; owner: string; superuser: boolean }>`
      select n.nspname as schema, r.rolname as owner, r.rolsuper as superuser
      from pg_namespace n join pg_roles r on r.oid = n.nspowner
      where n.nspname = any(${[...DB_SCHEMAS]})
      order by n.nspname
    `.execute(admin);
    expect(rows).toEqual(
      [...DB_SCHEMAS]
        .sort()
        .map((schema) => ({ schema, owner: `qtiauth_${schema}`, superuser: false })),
    );
  });

  it('is safe to run again', async () => {
    await expect(provisionRoles(admin, database)).resolves.toBeUndefined();
  });

  it("lets a service use its own schema but not another service's", async () => {
    await migrate(identity, {
      schema: 'identity',
      migrations: [
        {
          name: '0001_accounts',
          up: async (db) => {
            await sql`create table accounts (id int primary key)`.execute(db);
            await sql`insert into accounts values (1)`.execute(db);
          },
        },
      ],
    });
    const { rows } = await sql<{ id: number }>`select id from accounts`.execute(identity);
    expect(rows).toEqual([{ id: 1 }]);

    expect(await errorCode(sql`select * from identity.accounts`.execute(notify))).toBe('42501');
    expect(await errorCode(sql`create table public.leak (id int)`.execute(notify))).toBe('42501');
    expect(await errorCode(sql`create schema extra`.execute(notify))).toBe('42501');
    await expect(sql`create table notify.own (id int)`.execute(notify)).resolves.toBeDefined();
  });

  it('refuses roles without a password', async () => {
    const insecure = sections.database.parse({ name: database.name });
    await expect(provisionRoles(admin, insecure)).rejects.toThrow(
      'Set a password for every role: database.roles.identity.password',
    );
  });
});
