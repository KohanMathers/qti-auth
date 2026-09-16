import type { DbSchema, QtiauthConfig } from '@qtiauth/config';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

export type DatabaseConfig = QtiauthConfig['database'];

export interface DbCredentials {
  user: string;
  password: string;
}

function basePoolConfig(
  database: DatabaseConfig,
  credentials: DbCredentials,
  applicationName: string,
): pg.PoolConfig {
  return {
    host: database.host,
    port: database.port,
    database: database.name,
    user: credentials.user,
    password: credentials.password,
    ssl:
      database.ssl === 'disable' ? false : { rejectUnauthorized: database.ssl === 'verify-full' },
    max: database.pool.max,
    idleTimeoutMillis: database.pool.idle_timeout,
    connectionTimeoutMillis: database.pool.connect_timeout,
    application_name: applicationName,
  };
}

export function poolConfig(database: DatabaseConfig, schema: DbSchema): pg.PoolConfig {
  return {
    ...basePoolConfig(database, database.roles[schema], `qtiauth-${schema}`),
    options: `-c search_path=${schema}`,
  };
}

function kysely<DB>(config: pg.PoolConfig): Kysely<DB> {
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool: new pg.Pool(config) }) });
}

export function createDb<DB>(database: DatabaseConfig, schema: DbSchema): Kysely<DB> {
  return kysely(poolConfig(database, schema));
}

export function createAdminDb(
  database: DatabaseConfig,
  credentials: DbCredentials,
): Kysely<unknown> {
  return kysely({ ...basePoolConfig(database, credentials, 'qtiauth-admin'), max: 1 });
}
