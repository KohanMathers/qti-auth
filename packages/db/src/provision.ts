import { DB_SCHEMAS, type DbSchema } from '@qtiauth/config';
import { type Kysely, sql, type Transaction } from 'kysely';

import type { DatabaseConfig } from './connect.ts';

export class ProvisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProvisionError';
  }
}

async function run(db: Transaction<unknown>, template: string, ...args: string[]): Promise<void> {
  const values = sql.join(args.map((arg) => sql`${arg}::text`));
  const { rows } = await sql<{ statement: string }>`
    select format(${template}, variadic array[${values}]::text[]) as statement
  `.execute(db);
  await sql.raw(rows[0]?.statement ?? '').execute(db);
}

async function exists(db: Transaction<unknown>, query: ReturnType<typeof sql>): Promise<boolean> {
  const { rows } = await sql<{ exists: boolean }>`select exists (${query}) as exists`.execute(db);
  return rows[0]?.exists ?? false;
}

export async function provisionRoles(
  admin: Kysely<unknown>,
  database: DatabaseConfig,
  schemas: readonly DbSchema[] = DB_SCHEMAS,
): Promise<void> {
  const missing = schemas.filter((schema) => !database.roles[schema].password);
  if (missing.length > 0) {
    throw new ProvisionError(
      `Set a password for every role: ${missing.map((schema) => `database.roles.${schema}.password`).join(', ')}`,
    );
  }

  await admin.transaction().execute(async (trx) => {
    await run(trx, 'revoke all on database %I from public', database.name);
    await run(trx, 'revoke all on schema public from public');

    for (const schema of schemas) {
      const { user, password } = database.roles[schema];

      if (!(await exists(trx, sql`select 1 from pg_roles where rolname = ${user}`))) {
        await run(trx, 'create role %I', user);
      }
      await run(
        trx,
        'alter role %I with login nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls password %L',
        user,
        password,
      );
      await run(trx, 'alter role %I set search_path = %I', user, schema);
      await run(trx, 'grant connect on database %I to %I', database.name, user);

      if (await exists(trx, sql`select 1 from pg_namespace where nspname = ${schema}`)) {
        await run(trx, 'alter schema %I owner to %I', schema, user);
      } else {
        await run(trx, 'create schema %I authorization %I', schema, user);
      }
      await run(trx, 'revoke all on schema %I from public', schema);
    }
  });
}
