import { randomUUIDv7 } from 'node:crypto';

import type { EventActor } from '@qtiauth/events';
import type { Kysely } from 'kysely';
import * as z from 'zod';

import type { Database } from './database.ts';

export const PLACE_LEGAL_HOLD_METHOD = 'place_legal_hold';
export const LIFT_LEGAL_HOLD_METHOD = 'lift_legal_hold';
export const GET_LEGAL_HOLD_METHOD = 'get_legal_hold';

export const placeHoldRequestSchema = z.object({
  user_id: z.uuid(),
  reason: z.string().trim().min(1).max(500),
  case_id: z.string().trim().min(1).max(200).optional(),
});

export const liftHoldRequestSchema = z.object({
  user_id: z.uuid(),
  hold_id: z.uuid().optional(),
});

export const getHoldRequestSchema = z.object({ user_id: z.uuid() });

export interface LegalHold {
  id: string;
  user_id: string;
  reason: string;
  case_id: string | null;
  placed_at: Date;
  lifted_at: Date | null;
}

export type PlaceHoldResult = { status: 'ok'; hold: LegalHold } | { status: 'conflict' };

export async function getActiveHold(
  db: Kysely<Database>,
  userId: string,
): Promise<LegalHold | undefined> {
  return db
    .selectFrom('legal_holds')
    .select(['id', 'user_id', 'reason', 'case_id', 'placed_at', 'lifted_at'])
    .where('user_id', '=', userId)
    .where('lifted_at', 'is', null)
    .executeTakeFirst();
}

export async function hasActiveHold(db: Kysely<Database>, userId: string): Promise<boolean> {
  return (await getActiveHold(db, userId)) !== undefined;
}

export async function placeLegalHold(
  db: Kysely<Database>,
  options: {
    userId: string;
    reason: string;
    caseId?: string;
    actor: EventActor;
    now: Date;
  },
): Promise<PlaceHoldResult> {
  const existing = await db
    .selectFrom('legal_holds')
    .select('id')
    .where('user_id', '=', options.userId)
    .where('lifted_at', 'is', null)
    .executeTakeFirst();
  if (existing) return { status: 'conflict' };
  const id = randomUUIDv7();
  await db
    .insertInto('legal_holds')
    .values({
      id,
      user_id: options.userId,
      reason: options.reason,
      case_id: options.caseId ?? null,
      actor_type: options.actor.type,
      actor_id: options.actor.id,
      placed_at: options.now,
    })
    .execute();
  return {
    status: 'ok',
    hold: {
      id,
      user_id: options.userId,
      reason: options.reason,
      case_id: options.caseId ?? null,
      placed_at: options.now,
      lifted_at: null,
    },
  };
}

export async function liftLegalHold(
  db: Kysely<Database>,
  options: { userId: string; holdId?: string; now: Date },
): Promise<boolean> {
  let query = db
    .updateTable('legal_holds')
    .set({ lifted_at: options.now })
    .where('user_id', '=', options.userId)
    .where('lifted_at', 'is', null);
  if (options.holdId !== undefined) query = query.where('id', '=', options.holdId);
  const rows = await query.returning('id').execute();
  return rows.length > 0;
}

export function listLegalHolds(db: Kysely<Database>, userId: string): Promise<LegalHold[]> {
  return db
    .selectFrom('legal_holds')
    .select(['id', 'user_id', 'reason', 'case_id', 'placed_at', 'lifted_at'])
    .where('user_id', '=', userId)
    .orderBy('placed_at', 'desc')
    .execute();
}
