import type { Kysely, Transaction } from 'kysely';

import type { Database } from './database.ts';
import { iso } from './iso.ts';
import { endAccount, exportLogoutDeliveries } from './logout.ts';
import { eraseOwnedClients } from './portal.ts';

export async function exportUser(
  db: Kysely<Database>,
  userId: string,
): Promise<Record<string, unknown>> {
  const [owned, consents, refresh, access, devices, logouts] = await Promise.all([
    db
      .selectFrom('clients')
      .select([
        'clients.client_id as client_id',
        'clients.name as name',
        'clients.description as description',
        'clients.type as type',
        'clients.verified as verified',
        'clients.suspended_at as suspended_at',
        'clients.created_at as created_at',
      ])
      .where('clients.owner_user_id', '=', userId)
      .orderBy('clients.created_at')
      .execute(),
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
    db
      .selectFrom('device_authorizations')
      .innerJoin('clients', 'clients.id', 'device_authorizations.client_id')
      .select([
        'device_authorizations.id as id',
        'clients.client_id as client_id',
        'device_authorizations.scopes as scopes',
        'device_authorizations.status as status',
        'device_authorizations.expires_at as expires_at',
        'device_authorizations.created_at as created_at',
      ])
      .where('device_authorizations.user_id', '=', userId)
      .orderBy('device_authorizations.created_at')
      .execute(),
    exportLogoutDeliveries(db, userId),
  ]);
  return {
    clients: owned.map((row) => ({
      client_id: row.client_id,
      name: row.name,
      description: row.description,
      type: row.type,
      verified: row.verified,
      suspended: row.suspended_at !== null,
      created_at: iso(row.created_at),
    })),
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
    device_authorizations: devices.map((row) => ({
      id: row.id,
      client_id: row.client_id,
      scopes: row.scopes,
      status: row.status,
      expires_at: iso(row.expires_at),
      created_at: iso(row.created_at),
    })),
    logout_deliveries: logouts,
  };
}

export async function eraseUser(
  trx: Transaction<Database>,
  userId: string,
  options: { deliverLogout?: boolean; now?: Date } = {},
): Promise<void> {
  await eraseOwnedClients(trx, userId);
  await endAccount(trx, {
    userId,
    cause: 'deletion',
    now: options.now ?? new Date(),
    deliver: options.deliverLogout ?? false,
  });
  await trx.deleteFrom('device_authorizations').where('user_id', '=', userId).execute();
  await trx.deleteFrom('authorization_requests').where('user_id', '=', userId).execute();
  await trx.deleteFrom('authorization_codes').where('user_id', '=', userId).execute();
  await trx.deleteFrom('access_tokens').where('user_id', '=', userId).execute();
  await trx.deleteFrom('refresh_tokens').where('user_id', '=', userId).execute();
  await trx.deleteFrom('consents').where('user_id', '=', userId).execute();
}
