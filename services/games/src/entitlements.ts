import { randomUUID } from 'node:crypto';

import { writeEvent } from '@qtiauth/bus';
import type { EntitlementSource, GameStatus, ProductType } from '@qtiauth/config';
import { inTransaction, updatedRows } from '@qtiauth/db';
import type { EventActor } from '@qtiauth/events';
import type { Kysely } from 'kysely';

import type { Database } from './database.ts';
import {
  type AuditRecordedData,
  auditRecordedEvent,
  ENTITLEMENT_TRUST,
  type EntitlementGrantedData,
  entitlementGrantedEvent,
  type EntitlementRevokedData,
  entitlementRevokedEvent,
  SYSTEM_ACTOR,
} from './events.ts';

export const USER_ENTITLEMENTS_METHOD = 'user_entitlements';
export const USER_ENTITLEMENTS_LIMIT = 50;
export const EXPIRED_REASON = 'expired';

export interface EntitlementRecord {
  id: string;
  user_id: string;
  product_id: string;
  game_id: string;
  source: EntitlementSource;
  granted_by: string | null;
  granted_at: Date;
  expires_at: Date | null;
  revoked_at: Date | null;
  revoke_reason: string | null;
  created_at: Date;
}

export interface OwnedProduct {
  slug: string;
  name: string;
  type: ProductType;
  expires_at: Date | null;
}

export interface OwnedGame {
  id: string;
  slug: string;
  name: string;
  status: GameStatus;
  products: OwnedProduct[];
}

interface EntitlementRow {
  id: string;
  user_id: string;
  product_id: string;
  game_id: string;
  source: EntitlementSource;
  granted_by: string | null;
  granted_at: Date;
  expires_at: Date | null;
  revoked_at: Date | null;
  revoke_reason: string | null;
  created_at: Date;
}

function record(row: EntitlementRow): EntitlementRecord {
  return row;
}

function sameInstant(left: Date | null, right: Date | null): boolean {
  return (left?.getTime() ?? null) === (right?.getTime() ?? null);
}

async function writeAudit(
  db: Kysely<Database>,
  actor: EventActor,
  action: string,
  targetId: string,
): Promise<void> {
  await writeEvent<Database, AuditRecordedData>(
    db,
    auditRecordedEvent(actor, {
      action,
      target_type: 'entitlement',
      target_id: targetId,
    }),
  );
}

async function writeGranted(
  db: Kysely<Database>,
  row: EntitlementRecord,
  actor: EventActor,
): Promise<void> {
  const data: EntitlementGrantedData = {
    entitlement_id: row.id,
    user_id: row.user_id,
    game_id: row.game_id,
    product_id: row.product_id,
    source: row.source,
    trust: ENTITLEMENT_TRUST,
    expires_at: row.expires_at?.toISOString() ?? null,
  };
  await writeEvent<Database, EntitlementGrantedData>(
    db,
    entitlementGrantedEvent(row.id, data, actor),
  );
  await writeAudit(db, actor, 'games.entitlement.granted', row.id);
}

async function writeRevoked(
  db: Kysely<Database>,
  row: EntitlementRecord,
  reason: string,
  actor: EventActor,
): Promise<void> {
  const data: EntitlementRevokedData = {
    entitlement_id: row.id,
    user_id: row.user_id,
    game_id: row.game_id,
    product_id: row.product_id,
    source: row.source,
    trust: ENTITLEMENT_TRUST,
    reason,
  };
  await writeEvent<Database, EntitlementRevokedData>(
    db,
    entitlementRevokedEvent(row.id, data, actor),
  );
  await writeAudit(db, actor, 'games.entitlement.revoked', row.id);
}

function entitlementQuery(db: Kysely<Database>) {
  return db
    .selectFrom('entitlements')
    .innerJoin('products', 'products.id', 'entitlements.product_id')
    .select([
      'entitlements.id as id',
      'entitlements.user_id as user_id',
      'entitlements.product_id as product_id',
      'products.game_id as game_id',
      'entitlements.source as source',
      'entitlements.granted_by as granted_by',
      'entitlements.granted_at as granted_at',
      'entitlements.expires_at as expires_at',
      'entitlements.revoked_at as revoked_at',
      'entitlements.revoke_reason as revoke_reason',
      'entitlements.created_at as created_at',
    ]);
}

export async function grantEntitlement(
  db: Kysely<Database>,
  options: {
    userId: string;
    productId: string;
    gameId: string;
    source: EntitlementSource;
    grantedBy: string | null;
    expiresAt: Date | null;
    actor: EventActor;
    now: Date;
  },
): Promise<
  { status: 'ok'; entitlement: EntitlementRecord; changed: boolean } | { status: 'expired' }
> {
  if (options.expiresAt !== null && options.expiresAt <= options.now) return { status: 'expired' };
  return inTransaction(db, async (trx) => {
    const activeRow = await entitlementQuery(trx)
      .where('entitlements.user_id', '=', options.userId)
      .where('entitlements.product_id', '=', options.productId)
      .where('entitlements.source', '=', options.source)
      .where('entitlements.revoked_at', 'is', null)
      .executeTakeFirst();
    if (activeRow) {
      const current = record(activeRow);
      if (
        sameInstant(current.expires_at, options.expiresAt) &&
        current.granted_by === options.grantedBy
      ) {
        return { status: 'ok' as const, entitlement: current, changed: false };
      }
      const updated = await trx
        .updateTable('entitlements')
        .set({
          expires_at: options.expiresAt,
          granted_at: options.now,
          granted_by: options.grantedBy,
        })
        .where('id', '=', current.id)
        .where('revoked_at', 'is', null)
        .returningAll()
        .executeTakeFirst();
      if (!updated) return { status: 'ok' as const, entitlement: current, changed: false };
      const entitlement = record({ ...updated, game_id: options.gameId });
      await writeGranted(trx, entitlement, options.actor);
      return { status: 'ok' as const, entitlement, changed: true };
    }
    const id = randomUUID();
    const inserted = await trx
      .insertInto('entitlements')
      .values({
        id,
        user_id: options.userId,
        product_id: options.productId,
        source: options.source,
        granted_by: options.grantedBy,
        granted_at: options.now,
        expires_at: options.expiresAt,
        revoked_at: null,
        revoke_reason: null,
        created_at: options.now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const entitlement = record({ ...inserted, game_id: options.gameId });
    await writeGranted(trx, entitlement, options.actor);
    return { status: 'ok' as const, entitlement, changed: true };
  });
}

export async function revokeEntitlement(
  db: Kysely<Database>,
  options: {
    userId: string;
    productId: string;
    source: EntitlementSource;
    reason: string;
    actor: EventActor;
    now: Date;
  },
): Promise<
  { status: 'ok'; entitlement: EntitlementRecord } | { status: 'not_found' } | { status: 'revoked' }
> {
  return db.transaction().execute(async (trx) => {
    const activeRow = await entitlementQuery(trx)
      .where('entitlements.user_id', '=', options.userId)
      .where('entitlements.product_id', '=', options.productId)
      .where('entitlements.source', '=', options.source)
      .where('entitlements.revoked_at', 'is', null)
      .executeTakeFirst();
    if (!activeRow) return { status: 'not_found' as const };
    const result = await trx
      .updateTable('entitlements')
      .set({ revoked_at: options.now, revoke_reason: options.reason })
      .where('id', '=', activeRow.id)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    if (updatedRows(result) !== 1) return { status: 'revoked' as const };
    const entitlement = record({
      ...activeRow,
      revoked_at: options.now,
      revoke_reason: options.reason,
    });
    await writeRevoked(trx, entitlement, options.reason, options.actor);
    return { status: 'ok' as const, entitlement };
  });
}

export async function getEntitlement(
  db: Kysely<Database>,
  entitlementId: string,
): Promise<EntitlementRecord | undefined> {
  return entitlementQuery(db).where('entitlements.id', '=', entitlementId).executeTakeFirst();
}

export async function revokeEntitlementById(
  db: Kysely<Database>,
  options: { entitlementId: string; reason: string; actor: EventActor; now: Date },
): Promise<
  { status: 'ok'; entitlement: EntitlementRecord } | { status: 'not_found' } | { status: 'revoked' }
> {
  return db.transaction().execute(async (trx) => {
    const row = await entitlementQuery(trx)
      .where('entitlements.id', '=', options.entitlementId)
      .executeTakeFirst();
    if (!row) return { status: 'not_found' as const };
    if (row.revoked_at !== null) return { status: 'revoked' as const };
    const result = await trx
      .updateTable('entitlements')
      .set({ revoked_at: options.now, revoke_reason: options.reason })
      .where('id', '=', row.id)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    if (updatedRows(result) !== 1) return { status: 'revoked' as const };
    const entitlement = record({ ...row, revoked_at: options.now, revoke_reason: options.reason });
    await writeRevoked(trx, entitlement, options.reason, options.actor);
    return { status: 'ok' as const, entitlement };
  });
}

export async function listEntitlements(
  db: Kysely<Database>,
  options: {
    gameId?: string;
    userId?: string;
    after?: { granted_at: string; id: string };
    limit: number;
  },
): Promise<EntitlementRecord[]> {
  let query = entitlementQuery(db);
  if (options.gameId !== undefined) query = query.where('products.game_id', '=', options.gameId);
  if (options.userId !== undefined)
    query = query.where('entitlements.user_id', '=', options.userId);
  const after = options.after;
  if (after !== undefined) {
    const grantedAt = new Date(after.granted_at);
    query = query.where((eb) =>
      eb.or([
        eb('entitlements.granted_at', '<', grantedAt),
        eb.and([
          eb('entitlements.granted_at', '=', grantedAt),
          eb('entitlements.id', '<', after.id),
        ]),
      ]),
    );
  }
  const rows = await query
    .orderBy('entitlements.granted_at', 'desc')
    .orderBy('entitlements.id', 'desc')
    .limit(options.limit)
    .execute();
  return rows.map(record);
}

export async function expireEntitlements(
  db: Kysely<Database>,
  now: Date,
): Promise<EntitlementSource[]> {
  const due = await entitlementQuery(db)
    .where('entitlements.revoked_at', 'is', null)
    .where('entitlements.expires_at', 'is not', null)
    .where('entitlements.expires_at', '<=', now)
    .execute();
  const sources: EntitlementSource[] = [];
  for (const row of due) {
    const revoked = await db.transaction().execute(async (trx) => {
      const result = await trx
        .updateTable('entitlements')
        .set({ revoked_at: now, revoke_reason: EXPIRED_REASON })
        .where('id', '=', row.id)
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      if (updatedRows(result) !== 1) return false;
      await writeRevoked(
        trx,
        record({ ...row, revoked_at: now, revoke_reason: EXPIRED_REASON }),
        EXPIRED_REASON,
        SYSTEM_ACTOR,
      );
      return true;
    });
    if (revoked) sources.push(row.source);
  }
  return sources;
}

interface OwnedRow {
  game_id: string;
  game_slug: string;
  game_name: string;
  game_status: GameStatus;
  product_slug: string;
  product_name: string;
  product_type: ProductType;
  expires_at: Date | null;
}

function mergeExpiry(current: Date | null | undefined, next: Date | null): Date | null {
  if (current === undefined) return next;
  if (current === null || next === null) return null;
  return current > next ? current : next;
}

function groupOwned(rows: readonly OwnedRow[]): OwnedGame[] {
  const games = new Map<string, OwnedGame>();
  const seen = new Map<string, Map<string, OwnedProduct>>();
  for (const row of rows) {
    let game = games.get(row.game_id);
    if (!game) {
      game = {
        id: row.game_id,
        slug: row.game_slug,
        name: row.game_name,
        status: row.game_status,
        products: [],
      };
      games.set(row.game_id, game);
      seen.set(row.game_id, new Map());
    }
    const products = seen.get(row.game_id);
    if (!products) continue;
    const existing = products.get(row.product_slug);
    if (!existing) {
      const product = {
        slug: row.product_slug,
        name: row.product_name,
        type: row.product_type,
        expires_at: row.expires_at,
      };
      products.set(row.product_slug, product);
      game.products.push(product);
    } else {
      existing.expires_at = mergeExpiry(existing.expires_at, row.expires_at);
    }
  }
  return [...games.values()];
}

function ownedQuery(db: Kysely<Database>, userId: string, now: Date) {
  return db
    .selectFrom('entitlements')
    .innerJoin('products', 'products.id', 'entitlements.product_id')
    .innerJoin('games', 'games.id', 'products.game_id')
    .select([
      'games.id as game_id',
      'games.slug as game_slug',
      'games.name as game_name',
      'games.status as game_status',
      'products.slug as product_slug',
      'products.name as product_name',
      'products.type as product_type',
      'entitlements.expires_at as expires_at',
    ])
    .where('entitlements.user_id', '=', userId)
    .where('entitlements.revoked_at', 'is', null)
    .where((eb) =>
      eb.or([eb('entitlements.expires_at', 'is', null), eb('entitlements.expires_at', '>', now)]),
    );
}

export async function listOwned(
  db: Kysely<Database>,
  options: {
    userId: string;
    now: Date;
    after?: { name: string; id: string };
    limit: number;
  },
): Promise<OwnedGame[]> {
  let games = db
    .selectFrom('games')
    .select(['id', 'slug', 'name', 'status'])
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom('entitlements')
          .innerJoin('products', 'products.id', 'entitlements.product_id')
          .select('entitlements.id')
          .whereRef('products.game_id', '=', 'games.id')
          .where('entitlements.user_id', '=', options.userId)
          .where('entitlements.revoked_at', 'is', null)
          .where((inner) =>
            inner.or([
              inner('entitlements.expires_at', 'is', null),
              inner('entitlements.expires_at', '>', options.now),
            ]),
          ),
      ),
    );
  const after = options.after;
  if (after !== undefined) {
    games = games.where((eb) =>
      eb.or([
        eb('name', '>', after.name),
        eb.and([eb('name', '=', after.name), eb('id', '>', after.id)]),
      ]),
    );
  }
  const page = await games
    .orderBy('name', 'asc')
    .orderBy('id', 'asc')
    .limit(options.limit)
    .execute();
  if (page.length === 0) return [];
  const rows = await ownedQuery(db, options.userId, options.now)
    .where(
      'games.id',
      'in',
      page.map((game) => game.id),
    )
    .orderBy('games.name', 'asc')
    .orderBy('products.slug', 'asc')
    .execute();
  const grouped = groupOwned(rows);
  const order = new Map(page.map((game, index) => [game.id, index]));
  return grouped.toSorted((left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0));
}

export async function ownedGame(
  db: Kysely<Database>,
  options: { userId: string; gameId: string; now: Date },
): Promise<OwnedProduct[]> {
  const rows = await ownedQuery(db, options.userId, options.now)
    .where('games.id', '=', options.gameId)
    .orderBy('products.slug', 'asc')
    .execute();
  return groupOwned(rows)[0]?.products ?? [];
}

export async function exportUserEntitlements(
  db: Kysely<Database>,
  userId: string,
): Promise<Record<string, unknown>[]> {
  const rows = await db
    .selectFrom('entitlements')
    .innerJoin('products', 'products.id', 'entitlements.product_id')
    .innerJoin('games', 'games.id', 'products.game_id')
    .select([
      'entitlements.id as id',
      'games.slug as game_slug',
      'products.slug as product_slug',
      'products.type as product_type',
      'entitlements.source as source',
      'entitlements.granted_at as granted_at',
      'entitlements.expires_at as expires_at',
      'entitlements.revoked_at as revoked_at',
      'entitlements.revoke_reason as revoke_reason',
    ])
    .where('entitlements.user_id', '=', userId)
    .orderBy('entitlements.granted_at', 'desc')
    .execute();
  return rows.map((row) => ({
    id: row.id,
    game_slug: row.game_slug,
    product_slug: row.product_slug,
    product_type: row.product_type,
    source: row.source,
    granted_at: row.granted_at.toISOString(),
    expires_at: row.expires_at?.toISOString() ?? null,
    revoked_at: row.revoked_at?.toISOString() ?? null,
    revoke_reason: row.revoke_reason,
  }));
}

export async function eraseUserEntitlements(db: Kysely<Database>, userId: string): Promise<void> {
  await db.deleteFrom('entitlements').where('user_id', '=', userId).execute();
}
