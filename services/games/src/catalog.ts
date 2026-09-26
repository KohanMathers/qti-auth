import { randomUUID } from 'node:crypto';

import { writeEvent } from '@qtiauth/bus';
import {
  GAME_ART_MAX,
  GAME_DESCRIPTION_MAX,
  GAME_NAME_MAX,
  type GameStatus,
  type ProductType,
} from '@qtiauth/config';
import { updatedRows } from '@qtiauth/db';
import type { EventActor } from '@qtiauth/events';
import type { Kysely, Selectable } from 'kysely';

import type { Database, GamesTable, ProductsTable } from './database.ts';
import { type AuditRecordedData, auditRecordedEvent } from './events.ts';

export const PUBLIC_GAME_STATUSES = ['early_access', 'released'] as const;

export interface GameRecord {
  id: string;
  slug: string;
  name: string;
  description: string;
  icon: string | null;
  art: string | null;
  status: GameStatus;
  lease_duration_seconds: number | null;
  cloud_save_quota_bytes: number | null;
  steam_app_id: number | null;
  server_client_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ProductRecord {
  id: string;
  game_id: string;
  slug: string;
  name: string;
  description: string;
  type: ProductType;
  created_at: Date;
  updated_at: Date;
}

export type GameWriteError = 'not_found' | 'slug_taken' | 'invalid';
export type ProductWriteError = 'not_found' | 'slug_taken' | 'invalid' | 'base' | 'in_use';

export interface GameFields {
  slug?: string;
  name?: string;
  description?: string;
  icon?: string | null;
  art?: string | null;
  status?: GameStatus;
  lease_duration_seconds?: number | null;
  cloud_save_quota_bytes?: number | null;
  steam_app_id?: number | null;
}

function quota(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function gameRecord(row: Selectable<GamesTable>): GameRecord {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    icon: row.icon,
    art: row.art,
    status: row.status,
    lease_duration_seconds: row.lease_duration_seconds,
    cloud_save_quota_bytes: quota(row.cloud_save_quota_bytes),
    steam_app_id: row.steam_app_id,
    server_client_id: row.server_client_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function trimmed(value: string, max: number): string | undefined {
  const text = value.trim();
  if (text.length === 0 || text.length > max) return undefined;
  return text;
}

function optionalText(value: string | null, max: number): string | null | undefined {
  if (value === null) return null;
  const text = value.trim();
  if (text.length === 0 || text.length > max) return undefined;
  return text;
}

async function writeAudit(
  db: Kysely<Database>,
  actor: EventActor,
  action: string,
  targetType: string,
  targetId: string,
): Promise<void> {
  await writeEvent<Database, AuditRecordedData>(
    db,
    auditRecordedEvent(actor, { action, target_type: targetType, target_id: targetId }),
  );
}

async function slugTaken(db: Kysely<Database>, slug: string, exceptId?: string): Promise<boolean> {
  let query = db.selectFrom('games').select('id').where('slug', '=', slug);
  if (exceptId !== undefined) query = query.where('id', '!=', exceptId);
  const row = await query.executeTakeFirst();
  return row !== undefined;
}

async function productSlugTaken(
  db: Kysely<Database>,
  gameId: string,
  slug: string,
  exceptId?: string,
): Promise<boolean> {
  let query = db
    .selectFrom('products')
    .select('id')
    .where('game_id', '=', gameId)
    .where('slug', '=', slug);
  if (exceptId !== undefined) query = query.where('id', '!=', exceptId);
  const row = await query.executeTakeFirst();
  return row !== undefined;
}

export function isPublicGame(status: GameStatus): boolean {
  return (PUBLIC_GAME_STATUSES as readonly string[]).includes(status);
}

export async function getGameBySlug(
  db: Kysely<Database>,
  slug: string,
): Promise<GameRecord | undefined> {
  const row = await db.selectFrom('games').selectAll().where('slug', '=', slug).executeTakeFirst();
  return row ? gameRecord(row) : undefined;
}

export async function listProducts(db: Kysely<Database>, gameId: string): Promise<ProductRecord[]> {
  return db
    .selectFrom('products')
    .selectAll()
    .where('game_id', '=', gameId)
    .orderBy('type', 'asc')
    .orderBy('slug', 'asc')
    .execute();
}

export async function getProduct(
  db: Kysely<Database>,
  gameId: string,
  slug: string,
): Promise<ProductRecord | undefined> {
  return db
    .selectFrom('products')
    .selectAll()
    .where('game_id', '=', gameId)
    .where('slug', '=', slug)
    .executeTakeFirst();
}

export async function listGames(
  db: Kysely<Database>,
  options: {
    status?: GameStatus;
    publicOnly: boolean;
    after?: { name: string; id: string };
    limit: number;
  },
): Promise<GameRecord[]> {
  let query = db.selectFrom('games').selectAll();
  if (options.publicOnly) query = query.where('status', 'in', [...PUBLIC_GAME_STATUSES]);
  if (options.status !== undefined) query = query.where('status', '=', options.status);
  const after = options.after;
  if (after !== undefined) {
    query = query.where((eb) =>
      eb.or([
        eb('name', '>', after.name),
        eb.and([eb('name', '=', after.name), eb('id', '>', after.id)]),
      ]),
    );
  }
  const rows = await query
    .orderBy('name', 'asc')
    .orderBy('id', 'asc')
    .limit(options.limit)
    .execute();
  return rows.map(gameRecord);
}

export async function createGame(
  db: Kysely<Database>,
  options: {
    slug: string;
    name: string;
    description: string;
    icon: string | null;
    art: string | null;
    status: GameStatus;
    lease_duration_seconds: number | null;
    cloud_save_quota_bytes: number | null;
    steam_app_id: number | null;
    actor: EventActor;
    now: Date;
  },
): Promise<{ status: 'ok'; game: GameRecord } | { status: GameWriteError }> {
  const name = trimmed(options.name, GAME_NAME_MAX);
  const description = options.description.trim();
  if (name === undefined || description.length > GAME_DESCRIPTION_MAX) return { status: 'invalid' };
  const icon = optionalText(options.icon, GAME_ART_MAX);
  const art = optionalText(options.art, GAME_ART_MAX);
  if (icon === undefined || art === undefined) return { status: 'invalid' };

  return db.transaction().execute(async (trx) => {
    if (await slugTaken(trx, options.slug)) return { status: 'slug_taken' };
    const id = randomUUID();
    await trx
      .insertInto('games')
      .values({
        id,
        slug: options.slug,
        name,
        description,
        icon,
        art,
        status: options.status,
        lease_duration_seconds: options.lease_duration_seconds,
        cloud_save_quota_bytes:
          options.cloud_save_quota_bytes === null ? null : String(options.cloud_save_quota_bytes),
        steam_app_id: options.steam_app_id,
        server_client_id: null,
        created_at: options.now,
        updated_at: options.now,
      })
      .execute();
    await trx
      .insertInto('products')
      .values({
        id: randomUUID(),
        game_id: id,
        slug: 'base',
        name,
        description: '',
        type: 'base',
        created_at: options.now,
        updated_at: options.now,
      })
      .execute();
    await writeAudit(trx, options.actor, 'games.game.created', 'game', id);
    const game = await trx.selectFrom('games').selectAll().where('id', '=', id).executeTakeFirst();
    if (!game) return { status: 'not_found' };
    return { status: 'ok', game: gameRecord(game) };
  });
}

export async function updateGame(
  db: Kysely<Database>,
  options: GameFields & { currentSlug: string; actor: EventActor; now: Date },
): Promise<{ status: 'ok'; game: GameRecord } | { status: GameWriteError }> {
  return db.transaction().execute(async (trx) => {
    const current = await trx
      .selectFrom('games')
      .selectAll()
      .where('slug', '=', options.currentSlug)
      .executeTakeFirst();
    if (!current) return { status: 'not_found' };
    return applyGamePatch(trx, current, options, { updated_at: options.now });
  });
}

async function applyGamePatch(
  trx: Kysely<Database>,
  current: Selectable<GamesTable>,
  options: GameFields & { actor: EventActor; now: Date },
  patch: Partial<Selectable<GamesTable>>,
): Promise<{ status: 'ok'; game: GameRecord } | { status: GameWriteError }> {
  if (options.slug !== undefined && options.slug !== current.slug) {
    if (await slugTaken(trx, options.slug, current.id)) return { status: 'slug_taken' };
    patch.slug = options.slug;
  }
  if (options.name !== undefined) {
    const name = trimmed(options.name, GAME_NAME_MAX);
    if (name === undefined) return { status: 'invalid' };
    patch.name = name;
  }
  if (options.description !== undefined) {
    const description = options.description.trim();
    if (description.length > GAME_DESCRIPTION_MAX) return { status: 'invalid' };
    patch.description = description;
  }
  if (options.icon !== undefined) {
    const icon = optionalText(options.icon, GAME_ART_MAX);
    if (icon === undefined) return { status: 'invalid' };
    patch.icon = icon;
  }
  if (options.art !== undefined) {
    const art = optionalText(options.art, GAME_ART_MAX);
    if (art === undefined) return { status: 'invalid' };
    patch.art = art;
  }
  if (options.status !== undefined) patch.status = options.status;
  if (options.lease_duration_seconds !== undefined) {
    patch.lease_duration_seconds = options.lease_duration_seconds;
  }
  if (options.cloud_save_quota_bytes !== undefined) {
    patch.cloud_save_quota_bytes =
      options.cloud_save_quota_bytes === null ? null : String(options.cloud_save_quota_bytes);
  }
  if (options.steam_app_id !== undefined) patch.steam_app_id = options.steam_app_id;
  await trx.updateTable('games').set(patch).where('id', '=', current.id).execute();
  await writeAudit(trx, options.actor, 'games.game.updated', 'game', current.id);
  const game = await trx
    .selectFrom('games')
    .selectAll()
    .where('id', '=', current.id)
    .executeTakeFirst();
  if (!game) return { status: 'not_found' };
  return { status: 'ok', game: gameRecord(game) };
}

export async function setServerClient(
  db: Kysely<Database>,
  options: { gameId: string; clientId: string; now: Date },
): Promise<boolean> {
  const result = await db
    .updateTable('games')
    .set({ server_client_id: options.clientId, updated_at: options.now })
    .where('id', '=', options.gameId)
    .executeTakeFirst();
  return updatedRows(result) === 1;
}

export async function deleteGame(
  db: Kysely<Database>,
  options: { gameId: string; actor: EventActor },
): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    const current = await trx
      .selectFrom('games')
      .select('id')
      .where('id', '=', options.gameId)
      .executeTakeFirst();
    if (!current) return false;
    await writeAudit(trx, options.actor, 'games.game.deleted', 'game', current.id);
    await trx.deleteFrom('games').where('id', '=', current.id).execute();
    return true;
  });
}

export async function createProduct(
  db: Kysely<Database>,
  options: {
    gameId: string;
    slug: string;
    name: string;
    description: string;
    type: ProductType;
    actor: EventActor;
    now: Date;
  },
): Promise<{ status: 'ok'; product: ProductRecord } | { status: ProductWriteError }> {
  if (options.type === 'base') return { status: 'base' };
  const name = trimmed(options.name, GAME_NAME_MAX);
  const description = options.description.trim();
  if (name === undefined || description.length > GAME_DESCRIPTION_MAX) return { status: 'invalid' };
  return db.transaction().execute(async (trx) => {
    const game = await trx
      .selectFrom('games')
      .select('id')
      .where('id', '=', options.gameId)
      .executeTakeFirst();
    if (!game) return { status: 'not_found' };
    if (await productSlugTaken(trx, options.gameId, options.slug)) return { status: 'slug_taken' };
    const row = await trx
      .insertInto('products')
      .values({
        id: randomUUID(),
        game_id: options.gameId,
        slug: options.slug,
        name,
        description,
        type: options.type,
        created_at: options.now,
        updated_at: options.now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await writeAudit(trx, options.actor, 'games.product.created', 'product', row.id);
    return { status: 'ok', product: row };
  });
}

export async function updateProduct(
  db: Kysely<Database>,
  options: {
    gameId: string;
    slug: string;
    nextSlug?: string;
    name?: string;
    description?: string;
    type?: ProductType;
    actor: EventActor;
    now: Date;
  },
): Promise<{ status: 'ok'; product: ProductRecord } | { status: ProductWriteError }> {
  return db.transaction().execute(async (trx) => {
    const current = await trx
      .selectFrom('products')
      .selectAll()
      .where('game_id', '=', options.gameId)
      .where('slug', '=', options.slug)
      .executeTakeFirst();
    if (!current) return { status: 'not_found' };
    if (options.type === 'base' || (current.type === 'base' && options.type !== undefined)) {
      return { status: 'base' };
    }
    const patch: Partial<Selectable<ProductsTable>> = { updated_at: options.now };
    if (options.nextSlug !== undefined && options.nextSlug !== current.slug) {
      if (await productSlugTaken(trx, options.gameId, options.nextSlug, current.id)) {
        return { status: 'slug_taken' };
      }
      patch.slug = options.nextSlug;
    }
    if (options.name !== undefined) {
      const name = trimmed(options.name, GAME_NAME_MAX);
      if (name === undefined) return { status: 'invalid' };
      patch.name = name;
    }
    if (options.description !== undefined) {
      const description = options.description.trim();
      if (description.length > GAME_DESCRIPTION_MAX) return { status: 'invalid' };
      patch.description = description;
    }
    if (options.type !== undefined) patch.type = options.type;
    await trx.updateTable('products').set(patch).where('id', '=', current.id).execute();
    await writeAudit(trx, options.actor, 'games.product.updated', 'product', current.id);
    const product = await trx
      .selectFrom('products')
      .selectAll()
      .where('id', '=', current.id)
      .executeTakeFirst();
    if (!product) return { status: 'not_found' };
    return { status: 'ok', product };
  });
}

export async function deleteProduct(
  db: Kysely<Database>,
  options: { gameId: string; slug: string; actor: EventActor },
): Promise<{ status: 'ok' } | { status: ProductWriteError }> {
  return db.transaction().execute(async (trx) => {
    const current = await trx
      .selectFrom('products')
      .selectAll()
      .where('game_id', '=', options.gameId)
      .where('slug', '=', options.slug)
      .executeTakeFirst();
    if (!current) return { status: 'not_found' };
    if (current.type === 'base') return { status: 'base' };
    const used = await trx
      .selectFrom('entitlements')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('product_id', '=', current.id)
      .executeTakeFirstOrThrow();
    if (Number(used.count) > 0) return { status: 'in_use' };
    await writeAudit(trx, options.actor, 'games.product.deleted', 'product', current.id);
    await trx.deleteFrom('products').where('id', '=', current.id).execute();
    return { status: 'ok' };
  });
}
