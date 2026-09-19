import type { Kysely, Transaction } from 'kysely';

import type { Database } from './database.ts';
import { iso } from './iso.ts';

export async function exportUser(
  db: Kysely<Database>,
  userId: string,
): Promise<Record<string, unknown>> {
  const [consents, refresh, access] = await Promise.all([
    db
      .selectFrom('consents')
      .innerJoin('clients', 'clients.id', 'consents.client_id')
      .select([
        'clients.client_id as client_id',
        'clients.name as name',
        'consents.scopes as scopes',
        'consents.granted_at as granted_at',
      ])
      .where('consents.user_id', '=', userId)
      .orderBy('consents.granted_at')
      .execute(),
    db
      .selectFrom('refresh_tokens')
      .innerJoin('clients', 'clients.id', 'refresh_tokens.client_id')
      .select([
        'refresh_tokens.id as id',
        'clients.client_id as client_id',
        'refresh_tokens.scopes as scopes',
        'refresh_tokens.expires_at as expires_at',
        'refresh_tokens.revoked_at as revoked_at',
        'refresh_tokens.created_at as created_at',
      ])
      .where('refresh_tokens.user_id', '=', userId)
      .orderBy('refresh_tokens.created_at')
      .execute(),
    db
      .selectFrom('access_tokens')
      .innerJoin('clients', 'clients.id', 'access_tokens.client_id')
      .select([
        'access_tokens.id as id',
        'clients.client_id as client_id',
        'access_tokens.scopes as scopes',
        'access_tokens.expires_at as expires_at',
        'access_tokens.revoked_at as revoked_at',
        'access_tokens.created_at as created_at',
      ])
      .where('access_tokens.user_id', '=', userId)
      .orderBy('access_tokens.created_at')
      .execute(),
  ]);
  return {
    consents: consents.map((row) => ({
      client_id: row.client_id,
      name: row.name,
      scopes: row.scopes,
      granted_at: iso(row.granted_at),
    })),
    refresh_tokens: refresh.map((row) => ({
      id: row.id,
      client_id: row.client_id,
      scopes: row.scopes,
      expires_at: iso(row.expires_at),
      revoked_at: iso(row.revoked_at),
      created_at: iso(row.created_at),
    })),
    access_tokens: access.map((row) => ({
      id: row.id,
      client_id: row.client_id,
      scopes: row.scopes,
      expires_at: iso(row.expires_at),
      revoked_at: iso(row.revoked_at),
      created_at: iso(row.created_at),
    })),
  };
}

export async function eraseUser(trx: Transaction<Database>, userId: string): Promise<void> {
  await trx.deleteFrom('authorization_requests').where('user_id', '=', userId).execute();
  await trx.deleteFrom('authorization_codes').where('user_id', '=', userId).execute();
  await trx.deleteFrom('access_tokens').where('user_id', '=', userId).execute();
  await trx.deleteFrom('refresh_tokens').where('user_id', '=', userId).execute();
  await trx.deleteFrom('consents').where('user_id', '=', userId).execute();
}
