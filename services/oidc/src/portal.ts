import { randomUUIDv7 } from 'node:crypto';

import { writeEvent, type NewEvent } from '@qtiauth/bus';
import type { OidcClientType } from '@qtiauth/config';
import { AUDIT_EVENTS, type EventActor } from '@qtiauth/events';
import type { Kysely, Transaction } from 'kysely';

import { type ClientRecord, findClient, presentedClient } from './clients.ts';
import type { Database } from './database.ts';
import { clientCreatedEvent, type ClientCreatedData } from './events.ts';
import { isRedirectUri } from './redirect.ts';
import { hashToken, newToken } from './tokens.ts';

export type TextCheckResult = 'allow' | 'block' | 'unavailable';
export type TextCheck = (text: string, context: string) => Promise<TextCheckResult>;

export type ClientWriteError =
  | { status: 'not_found' }
  | { status: 'limit' }
  | { status: 'name_rejected' }
  | { status: 'description_rejected' }
  | { status: 'invalid_redirect'; uri: string }
  | { status: 'invalid_logout_uri' }
  | { status: 'unavailable' }
  | { status: 'public_no_secret' };

export type ClientWriteResult = { status: 'ok'; client: ClientRecord } | ClientWriteError;
export type ClientSecretResult =
  { status: 'ok'; client: ClientRecord; secret: string | null } | ClientWriteError;

interface AuditRecordedData {
  action: string;
  target_type: string;
  target_id: string;
}

export interface ClientFields {
  name: string;
  description: string;
  redirect_uris: readonly string[];
  require_par: boolean;
  backchannel_logout_uri: string | null;
  backchannel_logout_session_required: boolean;
}

function auditEvent(actor: EventActor, data: AuditRecordedData): NewEvent<AuditRecordedData> {
  return {
    type: AUDIT_EVENTS.recorded,
    actor,
    subject: { type: data.target_type, id: data.target_id },
    data,
  };
}

async function writeAudit(
  trx: Kysely<Database>,
  actor: EventActor,
  action: string,
  clientId: string,
): Promise<void> {
  await writeEvent<Database, AuditRecordedData>(
    trx,
    auditEvent(actor, { action, target_type: 'oauth_client', target_id: clientId }),
  );
}

export function containsProductName(name: string, productName: string): boolean {
  return name.toLowerCase().includes(productName.toLowerCase());
}

function checkedUris(
  uris: readonly string[],
): { uris: string[] } | { invalid: string } | { duplicate: true } {
  if (new Set(uris).size !== uris.length) return { duplicate: true };
  const invalid = uris.find((uri) => !isRedirectUri(uri));
  if (invalid !== undefined) return { invalid };
  return { uris: [...uris] };
}

async function screenedName(options: {
  name: string;
  productName: string;
  verified: boolean;
  checkText: TextCheck;
}): Promise<'ok' | 'name_rejected' | 'unavailable'> {
  if (!options.verified && containsProductName(options.name, options.productName)) {
    return 'name_rejected';
  }
  const decision = await options.checkText(options.name, 'oidc_client_name');
  if (decision === 'unavailable') return 'unavailable';
  if (decision === 'block') return 'name_rejected';
  return 'ok';
}

async function screenedDescription(
  description: string,
  checkText: TextCheck,
): Promise<'ok' | 'description_rejected' | 'unavailable'> {
  if (description === '') return 'ok';
  const decision = await checkText(description, 'oidc_client_description');
  if (decision === 'unavailable') return 'unavailable';
  if (decision === 'block') return 'description_rejected';
  return 'ok';
}

function fieldsError(
  fields: ClientFields,
): ClientWriteError | { uris: string[]; logoutUri: string | null } {
  const uris = checkedUris(fields.redirect_uris);
  if ('duplicate' in uris)
    return { status: 'invalid_redirect', uri: fields.redirect_uris[0] ?? '' };
  if ('invalid' in uris) return { status: 'invalid_redirect', uri: uris.invalid };
  if (fields.backchannel_logout_uri !== null && !isRedirectUri(fields.backchannel_logout_uri)) {
    return { status: 'invalid_logout_uri' };
  }
  return { uris: uris.uris, logoutUri: fields.backchannel_logout_uri };
}

export async function revokeClientTokens(
  db: Kysely<Database>,
  clientId: string,
  now: Date,
): Promise<void> {
  await db
    .updateTable('refresh_tokens')
    .set({ revoked_at: now })
    .where('client_id', '=', clientId)
    .where('revoked_at', 'is', null)
    .execute();
  await db
    .updateTable('access_tokens')
    .set({ revoked_at: now })
    .where('client_id', '=', clientId)
    .where('revoked_at', 'is', null)
    .execute();
}

export async function listOwnedClients(
  db: Kysely<Database>,
  ownerUserId: string,
): Promise<ClientRecord[]> {
  const rows = await db
    .selectFrom('clients')
    .selectAll()
    .where('owner_user_id', '=', ownerUserId)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .execute();
  return rows.map(presentedClient);
}

export async function listAllClients(
  db: Kysely<Database>,
  options: {
    limit: number;
    after?: { created_at: string; id: string } | undefined;
    verified?: boolean | undefined;
  },
): Promise<ClientRecord[]> {
  let query = db
    .selectFrom('clients')
    .selectAll()
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(options.limit + 1);
  if (options.verified !== undefined) {
    query = query.where((eb) =>
      options.verified === true
        ? eb.or([eb('verified', '=', true), eb('first_party', '=', true)])
        : eb.and([eb('verified', '=', false), eb('first_party', '=', false)]),
    );
  }
  const after = options.after;
  if (after) {
    query = query.where((eb) =>
      eb.or([
        eb('created_at', '<', new Date(after.created_at)),
        eb.and([eb('created_at', '=', new Date(after.created_at)), eb('id', '<', after.id)]),
      ]),
    );
  }
  const rows = await query.execute();
  return rows.map(presentedClient);
}

export async function getOwnedClient(
  db: Kysely<Database>,
  ownerUserId: string,
  clientId: string,
): Promise<ClientRecord | undefined> {
  const row = await db
    .selectFrom('clients')
    .selectAll()
    .where('client_id', '=', clientId)
    .where('owner_user_id', '=', ownerUserId)
    .executeTakeFirst();
  return row ? presentedClient(row) : undefined;
}

export async function createClient(
  db: Kysely<Database>,
  options: ClientFields & {
    ownerUserId: string;
    type: OidcClientType;
    actor: EventActor;
    now: Date;
    productName: string;
    maxClients: number;
    checkText: TextCheck;
  },
): Promise<ClientSecretResult> {
  const checked = fieldsError(options);
  if ('status' in checked) return checked;
  const nameCheck = await screenedName({
    name: options.name,
    productName: options.productName,
    verified: false,
    checkText: options.checkText,
  });
  if (nameCheck !== 'ok') return { status: nameCheck };
  const descriptionCheck = await screenedDescription(options.description, options.checkText);
  if (descriptionCheck !== 'ok') return { status: descriptionCheck };

  const secret = options.type === 'confidential' ? newToken() : null;
  return db.transaction().execute(async (trx) => {
    const owned = await trx
      .selectFrom('clients')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('owner_user_id', '=', options.ownerUserId)
      .executeTakeFirstOrThrow();
    if (Number(owned.count) >= options.maxClients) return { status: 'limit' };

    const id = randomUUIDv7();
    const clientId = newToken();
    await trx
      .insertInto('clients')
      .values({
        id,
        client_id: clientId,
        name: options.name,
        description: options.description,
        type: options.type,
        secret_hash: secret === null ? null : hashToken(secret),
        first_party: false,
        verified: false,
        redirect_uris: JSON.stringify(checked.uris),
        allowed_scopes: null,
        require_par: options.require_par,
        backchannel_logout_uri: checked.logoutUri,
        backchannel_logout_session_required: options.backchannel_logout_session_required,
        suspended_at: null,
        owner_user_id: options.ownerUserId,
        game_id: null,
        created_at: options.now,
        updated_at: options.now,
      })
      .execute();
    await writeEvent<Database, ClientCreatedData>(
      trx,
      clientCreatedEvent(clientId, options.actor, {
        client_id: clientId,
        client_type: options.type,
        owner_user_id: options.ownerUserId,
      }),
    );
    await writeAudit(trx, options.actor, 'oidc.client.created', clientId);
    const client = await getOwnedClient(trx, options.ownerUserId, clientId);
    if (client === undefined) return { status: 'not_found' };
    return { status: 'ok', client, secret };
  });
}

export async function updateClient(
  db: Kysely<Database>,
  options: Partial<ClientFields> & {
    ownerUserId: string;
    clientId: string;
    actor: EventActor;
    now: Date;
    productName: string;
    checkText: TextCheck;
  },
): Promise<ClientWriteResult> {
  const existing = await getOwnedClient(db, options.ownerUserId, options.clientId);
  if (!existing) return { status: 'not_found' };
  const next: ClientFields = {
    name: options.name ?? existing.name,
    description: options.description ?? existing.description,
    redirect_uris: options.redirect_uris ?? existing.redirect_uris,
    require_par: options.require_par ?? existing.require_par,
    backchannel_logout_uri:
      options.backchannel_logout_uri === undefined
        ? existing.backchannel_logout_uri
        : options.backchannel_logout_uri,
    backchannel_logout_session_required:
      options.backchannel_logout_session_required ?? existing.backchannel_logout_session_required,
  };
  const checked = fieldsError(next);
  if ('status' in checked) return checked;
  const nameCheck = await screenedName({
    name: next.name,
    productName: options.productName,
    verified: existing.verified || existing.first_party,
    checkText: options.checkText,
  });
  if (nameCheck !== 'ok') return { status: nameCheck };
  const descriptionCheck = await screenedDescription(next.description, options.checkText);
  if (descriptionCheck !== 'ok') return { status: descriptionCheck };

  return db.transaction().execute(async (trx) => {
    await trx
      .updateTable('clients')
      .set({
        name: next.name,
        description: next.description,
        redirect_uris: JSON.stringify(checked.uris),
        require_par: next.require_par,
        backchannel_logout_uri: checked.logoutUri,
        backchannel_logout_session_required: next.backchannel_logout_session_required,
        updated_at: options.now,
      })
      .where('id', '=', existing.id)
      .execute();
    await writeAudit(trx, options.actor, 'oidc.client.updated', existing.client_id);
    const client = await getOwnedClient(trx, options.ownerUserId, existing.client_id);
    if (client === undefined) return { status: 'not_found' };
    return { status: 'ok', client };
  });
}

export async function deleteClient(
  db: Kysely<Database>,
  options: { ownerUserId: string; clientId: string; actor: EventActor },
): Promise<ClientWriteResult> {
  return db.transaction().execute(async (trx) => {
    const existing = await getOwnedClient(trx, options.ownerUserId, options.clientId);
    if (!existing) return { status: 'not_found' };
    await writeAudit(trx, options.actor, 'oidc.client.deleted', existing.client_id);
    await trx.deleteFrom('clients').where('id', '=', existing.id).execute();
    return { status: 'ok', client: existing };
  });
}

export async function regenerateSecret(
  db: Kysely<Database>,
  options: { ownerUserId: string; clientId: string; actor: EventActor; now: Date },
): Promise<ClientSecretResult> {
  const existing = await getOwnedClient(db, options.ownerUserId, options.clientId);
  if (!existing) return { status: 'not_found' };
  if (existing.type !== 'confidential') return { status: 'public_no_secret' };
  const secret = newToken();
  return db.transaction().execute(async (trx) => {
    await trx
      .updateTable('clients')
      .set({ secret_hash: hashToken(secret), updated_at: options.now })
      .where('id', '=', existing.id)
      .execute();
    await writeAudit(trx, options.actor, 'oidc.client.secret_rotated', existing.client_id);
    const client = await getOwnedClient(trx, options.ownerUserId, existing.client_id);
    if (client === undefined) return { status: 'not_found' };
    return { status: 'ok', client, secret };
  });
}

export async function verifyClient(
  db: Kysely<Database>,
  options: { clientId: string; actor: EventActor; now: Date },
): Promise<ClientWriteResult> {
  const existing = await findClient(db, options.clientId);
  if (!existing) return { status: 'not_found' };
  return db.transaction().execute(async (trx) => {
    await trx
      .updateTable('clients')
      .set({ verified: true, updated_at: options.now })
      .where('id', '=', existing.id)
      .execute();
    await writeAudit(trx, options.actor, 'oidc.client.verified', existing.client_id);
    const row = await trx
      .selectFrom('clients')
      .selectAll()
      .where('id', '=', existing.id)
      .executeTakeFirst();
    if (!row) return { status: 'not_found' };
    return { status: 'ok', client: presentedClient(row) };
  });
}

export async function suspendClient(
  db: Kysely<Database>,
  options: { clientId: string; actor: EventActor; now: Date },
): Promise<ClientWriteResult> {
  const existing = await findClient(db, options.clientId);
  if (!existing) return { status: 'not_found' };
  return db.transaction().execute(async (trx) => {
    await trx
      .updateTable('clients')
      .set({ suspended_at: options.now, updated_at: options.now })
      .where('id', '=', existing.id)
      .execute();
    await revokeClientTokens(trx, existing.id, options.now);
    await writeAudit(trx, options.actor, 'oidc.client.suspended', existing.client_id);
    const row = await trx
      .selectFrom('clients')
      .selectAll()
      .where('id', '=', existing.id)
      .executeTakeFirst();
    if (!row) return { status: 'not_found' };
    return { status: 'ok', client: presentedClient(row) };
  });
}

export async function unsuspendClient(
  db: Kysely<Database>,
  options: { clientId: string; actor: EventActor; now: Date },
): Promise<ClientWriteResult> {
  const existing = await findClient(db, options.clientId);
  if (!existing) return { status: 'not_found' };
  return db.transaction().execute(async (trx) => {
    await trx
      .updateTable('clients')
      .set({ suspended_at: null, updated_at: options.now })
      .where('id', '=', existing.id)
      .execute();
    await writeAudit(trx, options.actor, 'oidc.client.unsuspended', existing.client_id);
    const row = await trx
      .selectFrom('clients')
      .selectAll()
      .where('id', '=', existing.id)
      .executeTakeFirst();
    if (!row) return { status: 'not_found' };
    return { status: 'ok', client: presentedClient(row) };
  });
}

export async function eraseOwnedClients(trx: Transaction<Database>, userId: string): Promise<void> {
  await trx.deleteFrom('clients').where('owner_user_id', '=', userId).execute();
}
