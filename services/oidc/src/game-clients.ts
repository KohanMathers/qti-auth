import { randomUUIDv7 } from 'node:crypto';

import { writeEvent } from '@qtiauth/bus';
import {
  ACHIEVEMENTS_WRITE_SCOPE,
  GAME_SERVER_SCOPE,
  GAME_STATS_WRITE_SCOPE,
  OIDC_CLIENT_NAME_MAX,
} from '@qtiauth/config';
import { AUDIT_EVENTS, type EventActor } from '@qtiauth/events';
import type { Kysely } from 'kysely';
import * as z from 'zod';

import type { Database } from './database.ts';
import { revokeClientTokens } from './portal.ts';
import { hashToken, newToken } from './tokens.ts';

export const PROVISION_GAME_CLIENT_METHOD = 'provision_game_client';
export const ROTATE_GAME_CLIENT_METHOD = 'rotate_game_client_secret';
export const RETIRE_GAME_CLIENT_METHOD = 'retire_game_client';

const actorSchema = z.object({
  type: z.enum(['user', 'service', 'system']),
  id: z.string().min(1),
});

export const provisionGameClientRequest = z.object({
  game_id: z.uuid(),
  name: z.string().min(1).max(OIDC_CLIENT_NAME_MAX),
  actor: actorSchema,
});

export const gameClientRequest = z.object({
  game_id: z.uuid(),
  actor: actorSchema,
});

export type ProvisionGameClientResult =
  { status: 'ok'; client_id: string; secret: string } | { status: 'exists'; client_id: string };

export type RotateGameClientResult =
  { status: 'ok'; client_id: string; secret: string } | { status: 'not_found' };

interface AuditRecordedData {
  action: string;
  target_type: string;
  target_id: string;
}

async function writeAudit(
  trx: Kysely<Database>,
  actor: EventActor,
  action: string,
  clientId: string,
): Promise<void> {
  await writeEvent<Database, AuditRecordedData>(trx, {
    type: AUDIT_EVENTS.recorded,
    actor,
    subject: { type: 'oauth_client', id: clientId },
    data: { action, target_type: 'oauth_client', target_id: clientId },
  });
}

async function clientForGame(
  db: Kysely<Database>,
  gameId: string,
): Promise<{ id: string; client_id: string } | undefined> {
  return db
    .selectFrom('clients')
    .select(['id', 'client_id'])
    .where('game_id', '=', gameId)
    .executeTakeFirst();
}

export async function provisionGameClient(
  db: Kysely<Database>,
  options: {
    gameId: string;
    name: string;
    actor: EventActor;
    now: Date;
    knownScopes: readonly string[];
  },
): Promise<ProvisionGameClientResult | { status: 'invalid' }> {
  const required = [GAME_SERVER_SCOPE, ACHIEVEMENTS_WRITE_SCOPE, GAME_STATS_WRITE_SCOPE];
  if (required.some((scope) => !options.knownScopes.includes(scope))) return { status: 'invalid' };
  const existing = await clientForGame(db, options.gameId);
  if (existing) return { status: 'exists', client_id: existing.client_id };

  const secret = newToken();
  const clientId = newToken();
  return db.transaction().execute(async (trx) => {
    const again = await clientForGame(trx, options.gameId);
    if (again) return { status: 'exists' as const, client_id: again.client_id };
    await trx
      .insertInto('clients')
      .values({
        id: randomUUIDv7(),
        client_id: clientId,
        name: options.name,
        description: '',
        type: 'confidential',
        secret_hash: hashToken(secret),
        first_party: false,
        verified: false,
        redirect_uris: [],
        allowed_scopes: [GAME_SERVER_SCOPE, ACHIEVEMENTS_WRITE_SCOPE, GAME_STATS_WRITE_SCOPE],
        require_par: false,
        backchannel_logout_uri: null,
        backchannel_logout_session_required: false,
        suspended_at: null,
        owner_user_id: null,
        game_id: options.gameId,
        created_at: options.now,
        updated_at: options.now,
      })
      .execute();
    await writeAudit(trx, options.actor, 'oidc.client.created', clientId);
    return { status: 'ok' as const, client_id: clientId, secret };
  });
}

export async function rotateGameClientSecret(
  db: Kysely<Database>,
  options: { gameId: string; actor: EventActor; now: Date },
): Promise<RotateGameClientResult> {
  const existing = await clientForGame(db, options.gameId);
  if (!existing) return { status: 'not_found' };
  const secret = newToken();
  return db.transaction().execute(async (trx) => {
    await trx
      .updateTable('clients')
      .set({ secret_hash: hashToken(secret), suspended_at: null, updated_at: options.now })
      .where('id', '=', existing.id)
      .execute();
    await writeAudit(trx, options.actor, 'oidc.client.secret_rotated', existing.client_id);
    return { status: 'ok' as const, client_id: existing.client_id, secret };
  });
}

export async function retireGameClient(
  db: Kysely<Database>,
  options: { gameId: string; actor: EventActor; now: Date },
): Promise<{ retired: boolean }> {
  const existing = await clientForGame(db, options.gameId);
  if (!existing) return { retired: false };
  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable('clients')
      .set({ suspended_at: options.now, updated_at: options.now })
      .where('id', '=', existing.id)
      .where('suspended_at', 'is', null)
      .execute();
    await revokeClientTokens(trx, existing.id, options.now);
    await writeAudit(trx, options.actor, 'oidc.client.suspended', existing.client_id);
  });
  return { retired: true };
}
