import { randomUUIDv7 } from 'node:crypto';

import type { OidcClientType } from '@qtiauth/config';
import type { Kysely, Selectable } from 'kysely';

import type { Database } from './database.ts';
import { redirectsMatch } from './redirect.ts';
import { hashToken, hashesMatch } from './tokens.ts';

export type ClientRow = Selectable<Database['clients']>;

export interface ClientRecord {
  id: string;
  client_id: string;
  name: string;
  description: string;
  type: OidcClientType;
  first_party: boolean;
  verified: boolean;
  redirect_uris: string[];
  allowed_scopes: string[] | null;
  require_par: boolean;
  backchannel_logout_uri: string | null;
  backchannel_logout_session_required: boolean;
  suspended_at: Date | null;
  owner_user_id: string | null;
  game_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ClientSeed {
  name: string;
  type: OidcClientType;
  first_party: boolean;
  verified: boolean;
  redirect_uris: readonly string[];
  allowed_scopes: readonly string[] | null;
  require_par: boolean;
  backchannel_logout_uri: string | null;
  backchannel_logout_session_required: boolean;
  secret: string;
}

function urisOf(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function scopesOf(value: unknown): string[] | null {
  return Array.isArray(value) ? value.map(String) : null;
}

export function presentedClient(row: ClientRow): ClientRecord {
  return {
    id: row.id,
    client_id: row.client_id,
    name: row.name,
    description: row.description,
    type: row.type,
    first_party: row.first_party,
    verified: row.verified,
    redirect_uris: urisOf(row.redirect_uris),
    allowed_scopes: scopesOf(row.allowed_scopes),
    require_par: row.require_par,
    backchannel_logout_uri: row.backchannel_logout_uri,
    backchannel_logout_session_required: row.backchannel_logout_session_required,
    suspended_at: row.suspended_at,
    owner_user_id: row.owner_user_id,
    game_id: row.game_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function isSuspended(client: ClientRecord, now: Date): boolean {
  return client.suspended_at !== null && client.suspended_at <= now;
}

export function redirectAllowed(client: ClientRecord, redirectUri: string): boolean {
  return redirectsMatch(client.redirect_uris, redirectUri);
}

export async function findClient(
  db: Kysely<Database>,
  clientId: string,
): Promise<(ClientRecord & { secret_hash: string | null }) | undefined> {
  const row = await db
    .selectFrom('clients')
    .selectAll()
    .where('client_id', '=', clientId)
    .executeTakeFirst();
  if (!row) return undefined;
  return { ...presentedClient(row), secret_hash: row.secret_hash };
}

export async function findClientById(
  db: Kysely<Database>,
  id: string,
): Promise<ClientRecord | undefined> {
  const row = await db.selectFrom('clients').selectAll().where('id', '=', id).executeTakeFirst();
  return row ? presentedClient(row) : undefined;
}

export function secretChecksOut(
  client: { type: OidcClientType; secret_hash: string | null },
  secret: string | undefined,
): boolean {
  if (client.type === 'public') return secret === undefined || secret === '';
  if (secret === undefined || secret === '' || client.secret_hash === null) return false;
  return hashesMatch(hashToken(secret), client.secret_hash);
}

export async function seedClients(
  db: Kysely<Database>,
  definitions: Record<string, ClientSeed>,
  now: Date,
): Promise<number> {
  let inserted = 0;
  for (const [clientId, definition] of Object.entries(definitions)) {
    const existing = await db
      .selectFrom('clients')
      .select('id')
      .where('client_id', '=', clientId)
      .executeTakeFirst();
    if (existing) continue;
    await db
      .insertInto('clients')
      .values({
        id: randomUUIDv7(),
        client_id: clientId,
        name: definition.name,
        description: '',
        type: definition.type,
        secret_hash:
          definition.type === 'confidential' && definition.secret !== ''
            ? hashToken(definition.secret)
            : null,
        first_party: definition.first_party,
        verified: definition.verified || definition.first_party,
        redirect_uris: JSON.stringify(definition.redirect_uris),
        allowed_scopes:
          definition.allowed_scopes === null ? null : JSON.stringify(definition.allowed_scopes),
        require_par: definition.require_par,
        backchannel_logout_uri: definition.backchannel_logout_uri,
        backchannel_logout_session_required: definition.backchannel_logout_session_required,
        suspended_at: null,
        owner_user_id: null,
        game_id: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
    inserted += 1;
  }
  return inserted;
}
