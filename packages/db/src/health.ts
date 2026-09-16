import type { HealthCheck } from '@qtiauth/observability';
import { type Kysely, sql } from 'kysely';

export function databaseHealthCheck<DB>(db: Kysely<DB>): HealthCheck {
  return async () => {
    await sql`select 1`.execute(db);
  };
}
