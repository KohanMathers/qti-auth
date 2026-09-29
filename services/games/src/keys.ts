import { createHash, randomInt, randomUUID } from 'node:crypto';

import { updatedRows } from '@qtiauth/db';
import type { EventActor } from '@qtiauth/events';
import { open, seal, sealedSecretSchema } from '@qtiauth/keys';
import type { Kysely, Selectable } from 'kysely';

import type { Database, GameKeysTable, KeyBatchesTable } from './database.ts';
import { grantEntitlement, revokeEntitlementById } from './entitlements.ts';

export interface KeyFormat {
  charset: string;
  group_length: number;
  groups: number;
}

export interface KeyBatchRecord {
  id: string;
  game_id: string;
  product_id: string;
  label: string;
  format: string;
  total_keys: number;
  expires_at: Date | null;
  created_by: string | null;
  created_at: Date;
  revoked_at: Date | null;
  revoke_reason: string | null;
}

export interface KeyBatchSummary extends KeyBatchRecord {
  redeemed_keys: number;
}

export function formatDescriptor(format: KeyFormat): string {
  return `${String(format.groups)}x${String(format.group_length)}`;
}

export function normalizeCode(code: string): string {
  return code.replaceAll(/[\s-]+/gu, '').toUpperCase();
}

export function hashCode(code: string): Uint8Array {
  return createHash('sha256').update(normalizeCode(code)).digest();
}

export function generateCode(format: KeyFormat): string {
  const groups: string[] = [];
  for (let g = 0; g < format.groups; g++) {
    let chars = '';
    for (let c = 0; c < format.group_length; c++) {
      chars += format.charset.charAt(randomInt(0, format.charset.length));
    }
    groups.push(chars);
  }
  return groups.join('-');
}

export function maskCode(code: string, format: KeyFormat): string {
  const parts = code.split('-');
  return parts
    .map((part, index) => (index === 0 ? part : '*'.repeat(format.group_length)))
    .join('-');
}

export function sealCode(code: string, key: Buffer, batchId: string): string {
  return JSON.stringify(seal(Buffer.from(code, 'utf8'), key, `key:${batchId}`));
}

export function openCode(sealed: string, key: Buffer, batchId: string): string {
  const parsed = sealedSecretSchema.safeParse(JSON.parse(sealed) as unknown);
  if (!parsed.success) throw new Error('sealed key is not in the expected format');
  return open(parsed.data, key, `key:${batchId}`).toString('utf8');
}

function batchRecord(row: Selectable<KeyBatchesTable>): KeyBatchRecord {
  return row;
}

export async function createKeyBatch(
  db: Kysely<Database>,
  options: {
    id: string;
    gameId: string;
    productId: string;
    label: string;
    format: KeyFormat;
    count: number;
    expiresAt: Date | null;
    createdBy: string | null;
    encryptionKey: Buffer;
    now: Date;
  },
): Promise<{ batch: KeyBatchRecord; codes: string[] }> {
  return db.transaction().execute(async (trx) => {
    const format = formatDescriptor(options.format);
    const inserted = await trx
      .insertInto('key_batches')
      .values({
        id: options.id,
        game_id: options.gameId,
        product_id: options.productId,
        label: options.label,
        format,
        total_keys: options.count,
        expires_at: options.expiresAt,
        created_by: options.createdBy,
        created_at: options.now,
        revoked_at: null,
        revoke_reason: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const codes: string[] = [];
    const seen = new Set<string>();
    const maxAttempts = options.count * 32 + 64;
    let attempts = 0;
    while (codes.length < options.count) {
      if (attempts >= maxAttempts) {
        throw new Error(
          `Could not generate ${String(options.count)} unique codes for format ${formatDescriptor(options.format)}`,
        );
      }
      attempts += 1;
      const code = generateCode(options.format);
      const normalized = normalizeCode(code);
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      codes.push(code);
    }
    const rows = codes.map((code) => ({
      id: randomUUID(),
      batch_id: inserted.id,
      code_hash: hashCode(code),
      code_display: maskCode(code, options.format),
      code_sealed: sealCode(code, options.encryptionKey, inserted.id),
      redeemed_by_user_id: null,
      redeemed_at: null,
      redeemed_ip: null,
      entitlement_id: null,
      revoked_at: null,
      created_at: options.now,
    }));
    for (let start = 0; start < rows.length; start += 500) {
      await trx
        .insertInto('game_keys')
        .values(rows.slice(start, start + 500))
        .execute();
    }
    return { batch: batchRecord(inserted), codes };
  });
}

export async function getKeyBatch(
  db: Kysely<Database>,
  batchId: string,
): Promise<KeyBatchSummary | undefined> {
  const batch = await db
    .selectFrom('key_batches')
    .selectAll()
    .where('id', '=', batchId)
    .executeTakeFirst();
  if (!batch) return undefined;
  const counts = await db
    .selectFrom('game_keys')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('batch_id', '=', batchId)
    .where('redeemed_at', 'is not', null)
    .executeTakeFirstOrThrow();
  return { ...batchRecord(batch), redeemed_keys: Number(counts.count) };
}

export async function listKeyBatches(
  db: Kysely<Database>,
  options: {
    gameId?: string;
    after?: { created_at: string; id: string };
    limit: number;
  },
): Promise<KeyBatchSummary[]> {
  let query = db.selectFrom('key_batches').selectAll();
  if (options.gameId !== undefined) query = query.where('game_id', '=', options.gameId);
  const after = options.after;
  if (after !== undefined) {
    const createdAt = new Date(after.created_at);
    query = query.where((eb) =>
      eb.or([
        eb('created_at', '<', createdAt),
        eb.and([eb('created_at', '=', createdAt), eb('id', '<', after.id)]),
      ]),
    );
  }
  const batches = await query
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(options.limit)
    .execute();
  if (batches.length === 0) return [];
  const rows = await db
    .selectFrom('game_keys')
    .select(['batch_id', (eb) => eb.fn.countAll<string>().as('count')])
    .where(
      'batch_id',
      'in',
      batches.map((batch) => batch.id),
    )
    .where('redeemed_at', 'is not', null)
    .groupBy('batch_id')
    .execute();
  const counts = new Map(rows.map((row) => [row.batch_id, Number(row.count)]));
  return batches.map((batch) => ({
    ...batchRecord(batch),
    redeemed_keys: counts.get(batch.id) ?? 0,
  }));
}

export async function listBatchKeys(
  db: Kysely<Database>,
  batchId: string,
): Promise<
  { id: string; code_display: string; redeemed_at: Date | null; revoked_at: Date | null }[]
> {
  return db
    .selectFrom('game_keys')
    .select(['id', 'code_display', 'redeemed_at', 'revoked_at'])
    .where('batch_id', '=', batchId)
    .orderBy('created_at', 'asc')
    .execute();
}

export async function exportBatchKeys(
  db: Kysely<Database>,
  options: { batchId: string; encryptionKey: Buffer },
): Promise<{ code: string; display: string; redeemed_at: Date | null; revoked_at: Date | null }[]> {
  const rows = await db
    .selectFrom('game_keys')
    .select(['code_sealed', 'code_display', 'redeemed_at', 'revoked_at'])
    .where('batch_id', '=', options.batchId)
    .orderBy('created_at', 'asc')
    .execute();
  return rows.map((row) => ({
    code: openCode(row.code_sealed, options.encryptionKey, options.batchId),
    display: row.code_display,
    redeemed_at: row.redeemed_at,
    revoked_at: row.revoked_at,
  }));
}

export interface RedeemLookup {
  key: Selectable<GameKeysTable>;
  batch: Selectable<KeyBatchesTable>;
  game: { id: string; slug: string };
  product: { id: string; slug: string };
}

export async function lookupKey(
  db: Kysely<Database>,
  code: string,
): Promise<RedeemLookup | undefined> {
  const codeHash = hashCode(code);
  const row = await db
    .selectFrom('game_keys')
    .innerJoin('key_batches', 'key_batches.id', 'game_keys.batch_id')
    .innerJoin('games', 'games.id', 'key_batches.game_id')
    .innerJoin('products', 'products.id', 'key_batches.product_id')
    .selectAll('game_keys')
    .select([
      'key_batches.id as batch_id_alias',
      'key_batches.game_id as batch_game_id',
      'key_batches.product_id as batch_product_id',
      'key_batches.label as batch_label',
      'key_batches.format as batch_format',
      'key_batches.total_keys as batch_total_keys',
      'key_batches.expires_at as batch_expires_at',
      'key_batches.created_by as batch_created_by',
      'key_batches.created_at as batch_created_at',
      'key_batches.revoked_at as batch_revoked_at',
      'key_batches.revoke_reason as batch_revoke_reason',
      'games.id as game_id_alias',
      'games.slug as game_slug',
      'products.id as product_id_alias',
      'products.slug as product_slug',
    ])
    .where('game_keys.code_hash', '=', codeHash)
    .executeTakeFirst();
  if (!row) return undefined;
  return {
    key: {
      id: row.id,
      batch_id: row.batch_id,
      code_hash: row.code_hash,
      code_display: row.code_display,
      code_sealed: row.code_sealed,
      redeemed_by_user_id: row.redeemed_by_user_id,
      redeemed_at: row.redeemed_at,
      redeemed_ip: row.redeemed_ip,
      entitlement_id: row.entitlement_id,
      revoked_at: row.revoked_at,
      created_at: row.created_at,
    },
    batch: {
      id: row.batch_id_alias,
      game_id: row.batch_game_id,
      product_id: row.batch_product_id,
      label: row.batch_label,
      format: row.batch_format,
      total_keys: row.batch_total_keys,
      expires_at: row.batch_expires_at,
      created_by: row.batch_created_by,
      created_at: row.batch_created_at,
      revoked_at: row.batch_revoked_at,
      revoke_reason: row.batch_revoke_reason,
    },
    game: { id: row.game_id_alias, slug: row.game_slug },
    product: { id: row.product_id_alias, slug: row.product_slug },
  };
}

export type RedeemOutcome =
  | { status: 'ok'; entitlement_id: string; game_slug: string; product_slug: string }
  | { status: 'invalid' }
  | { status: 'expired' }
  | { status: 'revoked' }
  | { status: 'already_redeemed' }
  | { status: 'already_owned' };

export async function redeemKey(
  db: Kysely<Database>,
  options: {
    code: string;
    userId: string;
    ip: string;
    actor: EventActor;
    now: Date;
  },
): Promise<RedeemOutcome> {
  const lookup = await lookupKey(db, options.code);
  if (!lookup) return { status: 'invalid' };
  if (lookup.key.revoked_at !== null) return { status: 'revoked' };
  if (lookup.batch.revoked_at !== null) return { status: 'revoked' };
  if (lookup.key.redeemed_at !== null) {
    return lookup.key.redeemed_by_user_id === options.userId
      ? { status: 'already_owned' }
      : { status: 'already_redeemed' };
  }
  const batchExpiry = lookup.batch.expires_at;
  if (batchExpiry !== null && batchExpiry <= options.now) return { status: 'expired' };
  return db.transaction().execute(async (trx) => {
    const claimed = await trx
      .updateTable('game_keys')
      .set({
        redeemed_by_user_id: options.userId,
        redeemed_at: options.now,
        redeemed_ip: options.ip,
      })
      .where('id', '=', lookup.key.id)
      .where('redeemed_at', 'is', null)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    if (updatedRows(claimed) !== 1) {
      const current = await trx
        .selectFrom('game_keys')
        .select(['redeemed_by_user_id', 'revoked_at'])
        .where('id', '=', lookup.key.id)
        .executeTakeFirstOrThrow();
      if (current.revoked_at !== null) return { status: 'revoked' as const };
      return current.redeemed_by_user_id === options.userId
        ? { status: 'already_owned' as const }
        : { status: 'already_redeemed' as const };
    }
    const grant = await grantEntitlement(trx, {
      userId: options.userId,
      productId: lookup.product.id,
      gameId: lookup.game.id,
      source: 'key_redemption',
      grantedBy: null,
      expiresAt: null,
      actor: options.actor,
      now: options.now,
    });
    if (grant.status === 'expired') return { status: 'expired' as const };
    await trx
      .updateTable('game_keys')
      .set({ entitlement_id: grant.entitlement.id })
      .where('id', '=', lookup.key.id)
      .execute();
    return {
      status: 'ok' as const,
      entitlement_id: grant.entitlement.id,
      game_slug: lookup.game.slug,
      product_slug: lookup.product.slug,
    };
  });
}

export interface BatchRevokeResult {
  batch: KeyBatchRecord;
  keys_revoked: number;
  entitlements_revoked: number;
}

export async function revokeKeyBatch(
  db: Kysely<Database>,
  options: {
    batchId: string;
    reason: string;
    revokeEntitlements: boolean;
    actor: EventActor;
    now: Date;
  },
): Promise<
  { status: 'ok'; result: BatchRevokeResult } | { status: 'not_found' } | { status: 'revoked' }
> {
  const batch = await db
    .selectFrom('key_batches')
    .selectAll()
    .where('id', '=', options.batchId)
    .executeTakeFirst();
  if (!batch) return { status: 'not_found' };
  if (batch.revoked_at !== null) return { status: 'revoked' };
  const updated = await db
    .updateTable('key_batches')
    .set({ revoked_at: options.now, revoke_reason: options.reason })
    .where('id', '=', options.batchId)
    .where('revoked_at', 'is', null)
    .executeTakeFirst();
  if (updatedRows(updated) !== 1) return { status: 'revoked' };
  const keys = await db
    .updateTable('game_keys')
    .set({ revoked_at: options.now })
    .where('batch_id', '=', options.batchId)
    .where('revoked_at', 'is', null)
    .where('redeemed_at', 'is', null)
    .executeTakeFirst();
  let entitlementsRevoked = 0;
  if (options.revokeEntitlements) {
    const redeemed = await db
      .selectFrom('game_keys')
      .select(['entitlement_id'])
      .where('batch_id', '=', options.batchId)
      .where('entitlement_id', 'is not', null)
      .execute();
    for (const row of redeemed) {
      if (row.entitlement_id === null) continue;
      const result = await revokeEntitlementById(db, {
        entitlementId: row.entitlement_id,
        reason: options.reason,
        actor: options.actor,
        now: options.now,
      });
      if (result.status === 'ok') entitlementsRevoked += 1;
    }
  }
  return {
    status: 'ok',
    result: {
      batch: {
        ...batchRecord(batch),
        revoked_at: options.now,
        revoke_reason: options.reason,
      },
      keys_revoked: updatedRows(keys),
      entitlements_revoked: entitlementsRevoked,
    },
  };
}

export function csvRow(values: readonly (string | null)[]): string {
  return `${values
    .map((value) => {
      if (value === null) return '';
      if (/[",\r\n]/.test(value)) return `"${value.replaceAll('"', '""')}"`;
      return value;
    })
    .join(',')}\r\n`;
}

export function batchCsv(
  batch: KeyBatchRecord,
  keys: readonly {
    code: string;
    display: string;
    redeemed_at: Date | null;
    revoked_at: Date | null;
  }[],
  now: Date,
): string {
  const header = csvRow(['code', 'display', 'status', 'redeemed_at']);
  const expired = batch.expires_at !== null && batch.expires_at <= now;
  const body = keys.map((row) => {
    const status = row.revoked_at
      ? 'revoked'
      : row.redeemed_at
        ? 'redeemed'
        : expired
          ? 'expired'
          : 'unused';
    return csvRow([row.code, row.display, status, row.redeemed_at?.toISOString() ?? null]);
  });
  return `${header}${body.join('')}`;
}

export async function eraseUserKeys(db: Kysely<Database>, userId: string): Promise<void> {
  await db
    .updateTable('game_keys')
    .set({ redeemed_by_user_id: null, redeemed_ip: null })
    .where('redeemed_by_user_id', '=', userId)
    .execute();
}

export async function exportUserKeys(
  db: Kysely<Database>,
  userId: string,
): Promise<Record<string, unknown>[]> {
  const rows = await db
    .selectFrom('game_keys')
    .innerJoin('key_batches', 'key_batches.id', 'game_keys.batch_id')
    .innerJoin('games', 'games.id', 'key_batches.game_id')
    .innerJoin('products', 'products.id', 'key_batches.product_id')
    .select([
      'game_keys.id as id',
      'game_keys.code_display as code_display',
      'game_keys.redeemed_at as redeemed_at',
      'game_keys.entitlement_id as entitlement_id',
      'games.slug as game_slug',
      'products.slug as product_slug',
    ])
    .where('game_keys.redeemed_by_user_id', '=', userId)
    .orderBy('game_keys.redeemed_at', 'desc')
    .execute();
  return rows.map((row) => ({
    id: row.id,
    code_display: row.code_display,
    game_slug: row.game_slug,
    product_slug: row.product_slug,
    redeemed_at: row.redeemed_at?.toISOString() ?? null,
    entitlement_id: row.entitlement_id,
  }));
}

export async function sweepRedeemAttempts(
  db: Kysely<Database>,
  options: { retention: number; now: Date },
): Promise<number> {
  const result = await db
    .deleteFrom('key_redeem_attempts')
    .where('updated_at', '<', new Date(options.now.getTime() - options.retention))
    .executeTakeFirst();
  return Number(result.numDeletedRows);
}
