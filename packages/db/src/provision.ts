import { DB_SCHEMAS, type DbSchema } from '@qtiauth/config';
import { type Kysely, sql } from 'kysely';

import type { DatabaseConfig, DbCredentials } from './connect.ts';

export class ProvisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProvisionError';
  }
}

async function run<DB>(db: Kysely<DB>, template: string, ...args: string[]): Promise<void> {
  const values = sql.join(args.map((arg) => sql`${arg}::text`));
  const { rows } = await sql<{ statement: string }>`
    select format(${template}, variadic array[${values}]::text[]) as statement
  `.execute(db);
  await sql.raw(rows[0]?.statement ?? '').execute(db);
}

async function exists<DB>(db: Kysely<DB>, query: ReturnType<typeof sql>): Promise<boolean> {
  const { rows } = await sql<{ exists: boolean }>`select exists (${query}) as exists`.execute(db);
  return rows[0]?.exists ?? false;
}

async function provisionLoginRole(
  db: Kysely<unknown>,
  database: DatabaseConfig,
  credentials: DbCredentials,
  searchPath: string,
): Promise<void> {
  const { user, password } = credentials;
  if (!(await exists(db, sql`select 1 from pg_roles where rolname = ${user}`))) {
    await run(db, 'create role %I', user);
  }
  await run(
    db,
    'alter role %I with login nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls password %L',
    user,
    password,
  );
  await run(db, 'alter role %I set search_path = %I', user, searchPath);
  await run(db, 'grant connect on database %I to %I', database.name, user);
}

export async function applyAuditLogPrivileges<DB>(
  db: Kysely<DB>,
  database: DatabaseConfig,
): Promise<void> {
  if (
    !(await exists(
      db,
      sql`
        select 1
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'identity' and c.relname = 'audit_log'
      `,
    ))
  ) {
    return;
  }

  await run(
    db,
    'revoke update, truncate on table %I.%I from %I',
    'identity',
    'audit_log',
    database.roles.identity.user,
  );

  if (!(await exists(db, sql`select 1 from pg_roles where rolname = ${database.audit.user}`))) {
    return;
  }

  await run(db, 'grant usage on schema %I to %I', 'identity', database.audit.user);
  await run(
    db,
    'grant select, insert on table %I.%I to %I',
    'identity',
    'audit_log',
    database.audit.user,
  );
}

export async function provisionRoles(
  admin: Kysely<unknown>,
  database: DatabaseConfig,
  schemas: readonly DbSchema[] = DB_SCHEMAS,
): Promise<void> {
  const missing = [
    ...schemas
      .filter((schema) => !database.roles[schema].password)
      .map((schema) => `database.roles.${schema}.password`),
    ...(!database.audit.password ? ['database.audit.password'] : []),
  ];
  if (missing.length > 0) {
    throw new ProvisionError(`Set a password for every role: ${missing.join(', ')}`);
  }

  await admin.transaction().execute(async (trx) => {
    await run(trx, 'revoke all on database %I from public', database.name);
    await run(trx, 'revoke all on schema public from public');

    for (const schema of schemas) {
      const { user, password } = database.roles[schema];
      await provisionLoginRole(trx, database, { user, password }, schema);

      if (await exists(trx, sql`select 1 from pg_namespace where nspname = ${schema}`)) {
        await run(trx, 'alter schema %I owner to %I', schema, user);
      } else {
        await run(trx, 'create schema %I authorization %I', schema, user);
      }
      await run(trx, 'revoke all on schema %I from public', schema);
    }

    await provisionLoginRole(trx, database, database.audit, 'identity');
    if (await exists(trx, sql`select 1 from pg_namespace where nspname = ${'identity'}`)) {
      await run(trx, 'grant usage on schema %I to %I', 'identity', database.audit.user);
    }
    await applyAuditLogPrivileges(trx, database);
  });
}
