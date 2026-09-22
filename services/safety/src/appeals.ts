import { randomUUID } from 'node:crypto';

import { type Bus, rpcRequest, writeEvent } from '@qtiauth/bus';
import type { EventActor } from '@qtiauth/events';
import type { Kysely } from 'kysely';

import type { AppealStatus, Database } from './database.ts';
import {
  appealCreatedEvent,
  type AppealCreatedData,
  appealResolvedEvent,
  type AppealResolvedData,
} from './events.ts';
import { getAction, liftAction, type AppliedAction } from './moderation.ts';

export const CREATE_APPEAL_SERVICE = 'support';
export const CREATE_APPEAL_METHOD = 'create_appeal';

export interface AppealRecord {
  id: string;
  action_id: string;
  user_id: string | null;
  body: string;
  status: AppealStatus;
  ticket_id: string | null;
  resolved_by: string | null;
  created_at: Date;
  resolved_at: Date | null;
}

export type CreateAppealResult =
  | { status: 'ok'; appeal: AppealRecord }
  | { status: 'not_found' }
  | { status: 'not_allowed' }
  | { status: 'exists' }
  | { status: 'too_long' };

function appealable(action: AppliedAction): boolean {
  if (action.status !== 'applied') return false;
  return (
    action.action === 'lock' ||
    action.action === 'ban' ||
    action.action === 'restrict' ||
    action.action === 'proscribed_org_removal'
  );
}

async function trySupportTicket(
  bus: Bus,
  enabled: boolean,
  payload: { user_id: string; action_id: string; body: string },
): Promise<string | null> {
  if (!enabled) return null;
  const result = await rpcRequest<{ ticket_id: string }>(
    bus,
    CREATE_APPEAL_SERVICE,
    CREATE_APPEAL_METHOD,
    payload,
  );
  if (result.status !== 'ok') return null;
  return result.data.ticket_id;
}

export async function createAppeal(
  db: Kysely<Database>,
  bus: Bus,
  options: {
    actionId: string;
    userId: string;
    body: string;
    maxLength: number;
    supportTickets: boolean;
    now: Date;
  },
): Promise<CreateAppealResult> {
  if (options.body.length > options.maxLength) return { status: 'too_long' };
  const action = await getAction(db, options.actionId);
  if (!action) return { status: 'not_found' };
  if (action.user_id !== options.userId) return { status: 'not_found' };
  if (!appealable(action)) return { status: 'not_allowed' };

  const existing = await db
    .selectFrom('appeals')
    .select('id')
    .where('action_id', '=', options.actionId)
    .where('status', '=', 'open')
    .executeTakeFirst();
  if (existing) return { status: 'exists' };

  const ticketId = await trySupportTicket(bus, options.supportTickets, {
    user_id: options.userId,
    action_id: options.actionId,
    body: options.body,
  });
  const id = randomUUID();
  const actor: EventActor = { type: 'user', id: options.userId };
  const appeal = await db.transaction().execute(async (trx) => {
    await trx
      .insertInto('appeals')
      .values({
        id,
        action_id: options.actionId,
        user_id: options.userId,
        body: options.body,
        status: 'open',
        ticket_id: ticketId,
        resolved_by: null,
        created_at: options.now,
        resolved_at: null,
      })
      .execute();
    await writeEvent<Database, AppealCreatedData>(
      trx,
      appealCreatedEvent(
        id,
        {
          appeal_id: id,
          action_id: options.actionId,
          action: action.action,
          user_id: options.userId,
          ticket_id: ticketId,
        },
        actor,
      ),
    );
    return {
      id,
      action_id: options.actionId,
      user_id: options.userId,
      body: options.body,
      status: 'open' as const,
      ticket_id: ticketId,
      resolved_by: null,
      created_at: options.now,
      resolved_at: null,
    };
  });
  return { status: 'ok', appeal };
}

export async function getAppeal(
  db: Kysely<Database>,
  id: string,
): Promise<AppealRecord | undefined> {
  return db.selectFrom('appeals').selectAll().where('id', '=', id).executeTakeFirst();
}

export async function listUserAppeals(
  db: Kysely<Database>,
  userId: string,
): Promise<AppealRecord[]> {
  return db
    .selectFrom('appeals')
    .selectAll()
    .where('user_id', '=', userId)
    .orderBy('created_at', 'desc')
    .execute();
}

export async function listAppeals(
  db: Kysely<Database>,
  options: { status?: AppealStatus; after?: { created_at: string; id: string }; limit: number },
): Promise<AppealRecord[]> {
  let query = db.selectFrom('appeals').selectAll();
  if (options.status !== undefined) query = query.where('status', '=', options.status);
  if (options.after !== undefined) {
    const createdAt = new Date(options.after.created_at);
    const afterId = options.after.id;
    query = query.where((eb) =>
      eb.or([
        eb('created_at', '<', createdAt),
        eb.and([eb('created_at', '=', createdAt), eb('id', '<', afterId)]),
      ]),
    );
  }
  return query.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(options.limit).execute();
}

export type ResolveAppealResult =
  | { status: 'ok'; appeal: AppealRecord; action: AppliedAction }
  | { status: 'not_found' }
  | { status: 'closed' };

export async function resolveAppeal(
  db: Kysely<Database>,
  options: {
    appealId: string;
    actorId: string;
    outcome: 'lifted' | 'upheld';
    now: Date;
  },
): Promise<ResolveAppealResult> {
  const appeal = await getAppeal(db, options.appealId);
  if (!appeal) return { status: 'not_found' };
  if (appeal.status !== 'open') return { status: 'closed' };
  const action = await getAction(db, appeal.action_id);
  if (!action) return { status: 'not_found' };
  const userId = appeal.user_id ?? action.user_id;
  if (userId === null) return { status: 'not_found' };

  const actor: EventActor = { type: 'user', id: options.actorId };
  const resolved = await db.transaction().execute(async (trx) => {
    const updated = await trx
      .updateTable('appeals')
      .set({
        status: options.outcome,
        resolved_by: options.actorId,
        resolved_at: options.now,
      })
      .where('id', '=', options.appealId)
      .where('status', '=', 'open')
      .returningAll()
      .executeTakeFirst();
    if (!updated) return null;
    if (options.outcome === 'lifted') await liftAction(trx, action.id, options.now);
    await writeEvent<Database, AppealResolvedData>(
      trx,
      appealResolvedEvent(
        appeal.id,
        {
          appeal_id: appeal.id,
          action_id: action.id,
          action: action.action,
          user_id: userId,
          outcome: options.outcome,
          ...(action.action === 'restrict' && options.outcome === 'lifted'
            ? { restrictions: action.restrictions }
            : {}),
        },
        actor,
      ),
    );
    return updated;
  });
  if (!resolved) return { status: 'closed' };
  return {
    status: 'ok',
    appeal: resolved,
    action: options.outcome === 'lifted' ? { ...action, status: 'lifted' } : action,
  };
}
