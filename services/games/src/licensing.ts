import { createHash, createPublicKey, type KeyObject, randomUUID, sign, verify } from 'node:crypto';

import { writeEvent } from '@qtiauth/bus';
import type { ProductType } from '@qtiauth/config';
import { updatedRows } from '@qtiauth/db';
import type { EventActor } from '@qtiauth/events';
import type { PublicJwk, SigningAlgorithm } from '@qtiauth/keys';
import type { Kysely, Selectable } from 'kysely';

import type { Database, LeasedProduct, LicenseLeasesTable } from './database.ts';
import {
  type AuditRecordedData,
  auditRecordedEvent,
  type LicenseLeaseIssuedData,
  licenseLeaseIssuedEvent,
  type LicenseLeaseRevokedData,
  licenseLeaseRevokedEvent,
} from './events.ts';
import type { Keyring } from './licensing-keys.ts';

export const LEASE_TOKEN_TYPE = 'qtiauth-license+jwt';

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;

export interface LeaseHeader {
  alg: SigningAlgorithm;
  typ: string;
  kid: string;
}

export interface LeasePayload {
  jti: string;
  iss: string;
  sub: string;
  aud: string;
  iat: number;
  exp: number;
  game_slug: string;
  products: LeasedProduct[];
  device_hash: string | null;
}

export interface RevocationListPayload {
  iss: string;
  issued_at: number;
  expires_at: number;
  game_slug: string | null;
  since: number | null;
  revocations: { jti: string; game_slug: string; revoked_at: number; expires_at: number }[];
}

export interface LeaseRecord {
  id: string;
  user_id: string;
  game_id: string;
  device_hash: string | null;
  device_label: string | null;
  products: LeasedProduct[];
  issued_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  revoke_reason: string | null;
  last_seen_at: Date | null;
  created_at: Date;
}

function encodeSegment(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decodeSegment(segment: string): unknown {
  if (!BASE64URL_PATTERN.test(segment)) return undefined;
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function signBytes(alg: SigningAlgorithm, input: Buffer, key: KeyObject): Buffer {
  if (alg === 'EdDSA') return sign(null, input, key);
  if (alg === 'ES256') return sign('sha256', input, { key, dsaEncoding: 'ieee-p1363' });
  return sign('sha256', input, key);
}

function verifyBytes(
  alg: SigningAlgorithm,
  input: Buffer,
  key: KeyObject,
  signature: Buffer,
): boolean {
  try {
    if (alg === 'EdDSA') return verify(null, input, key, signature);
    if (alg === 'ES256') {
      return verify('sha256', input, { key, dsaEncoding: 'ieee-p1363' }, signature);
    }
    return verify('sha256', input, key, signature);
  } catch {
    return false;
  }
}

export function signLease(
  payload: LeasePayload,
  key: { alg: SigningAlgorithm; kid: string; privateKey: KeyObject },
): string {
  const header: LeaseHeader = { alg: key.alg, typ: LEASE_TOKEN_TYPE, kid: key.kid };
  const signingInput = `${encodeSegment(header)}.${encodeSegment(payload)}`;
  const signature = signBytes(key.alg, Buffer.from(signingInput), key.privateKey);
  return `${signingInput}.${signature.toString('base64url')}`;
}

export interface VerifiedLease {
  header: LeaseHeader;
  payload: LeasePayload;
}

export function decodeLeaseHeader(token: string): LeaseHeader | undefined {
  const [headerSegment] = token.split('.');
  if (headerSegment === undefined) return undefined;
  const header = decodeSegment(headerSegment) as LeaseHeader | undefined;
  if (
    header === undefined ||
    typeof header.alg !== 'string' ||
    header.typ !== LEASE_TOKEN_TYPE ||
    typeof header.kid !== 'string' ||
    header.kid === ''
  ) {
    return undefined;
  }
  return header;
}

export function verifyLease(
  token: string,
  options: {
    issuer: string;
    getKey: (kid: string, alg: SigningAlgorithm) => KeyObject | undefined;
    now?: Date;
  },
): VerifiedLease | undefined {
  const parts = token.split('.');
  const [headerSegment, payloadSegment, signatureSegment] = parts;
  if (
    parts.length !== 3 ||
    headerSegment === undefined ||
    payloadSegment === undefined ||
    signatureSegment === undefined
  ) {
    return undefined;
  }
  const header = decodeLeaseHeader(token);
  if (header === undefined) return undefined;
  const key = options.getKey(header.kid, header.alg);
  if (!key) return undefined;
  if (!BASE64URL_PATTERN.test(signatureSegment)) return undefined;
  const signature = Buffer.from(signatureSegment, 'base64url');
  if (!verifyBytes(header.alg, Buffer.from(`${headerSegment}.${payloadSegment}`), key, signature)) {
    return undefined;
  }
  const payload = decodeSegment(payloadSegment) as LeasePayload | undefined;
  if (
    payload === undefined ||
    typeof payload.jti !== 'string' ||
    typeof payload.sub !== 'string' ||
    payload.iss !== options.issuer ||
    typeof payload.iat !== 'number' ||
    typeof payload.exp !== 'number' ||
    typeof payload.game_slug !== 'string' ||
    !Array.isArray(payload.products)
  ) {
    return undefined;
  }
  const now = Math.floor((options.now ?? new Date()).getTime() / 1000);
  if (payload.exp <= now) return undefined;
  if (payload.iat > now + 60) return undefined;
  return { header, payload };
}

export function hashDeviceId(deviceId: string): string {
  return createHash('sha256').update(deviceId).digest('base64url');
}

function publicKeyFromJwk(jwk: PublicJwk): KeyObject | undefined {
  try {
    return createPublicKey({ key: jwk, format: 'jwk' });
  } catch {
    return undefined;
  }
}

export function keyResolver(keyring: Keyring) {
  return async (kid: string, alg: SigningAlgorithm): Promise<KeyObject | undefined> => {
    const jwks = await keyring.jwks();
    const jwk = jwks.keys.find((entry) => entry.kid === kid && entry.alg === alg);
    if (!jwk) return undefined;
    return publicKeyFromJwk(jwk);
  };
}

export async function verifyLeaseWithKeyring(
  token: string,
  keyring: Keyring,
  options: { issuer: string; now?: Date },
): Promise<VerifiedLease | undefined> {
  const header = decodeLeaseHeader(token);
  if (header === undefined) return undefined;
  const resolve = keyResolver(keyring);
  const key = await resolve(header.kid, header.alg);
  if (key === undefined) return undefined;
  return verifyLease(token, {
    issuer: options.issuer,
    getKey: (kid, alg) => (kid === header.kid && alg === header.alg ? key : undefined),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
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
      target_type: 'license_lease',
      target_id: targetId,
    }),
  );
}

interface OwnedRow {
  slug: string;
  type: ProductType;
  expires_at: Date | null;
}

async function ownedProductsForGame(
  db: Kysely<Database>,
  options: { userId: string; gameId: string; now: Date },
): Promise<OwnedRow[]> {
  const rows = await db
    .selectFrom('entitlements')
    .innerJoin('products', 'products.id', 'entitlements.product_id')
    .select(['products.slug as slug', 'products.type as type', 'entitlements.expires_at'])
    .where('entitlements.user_id', '=', options.userId)
    .where('entitlements.revoked_at', 'is', null)
    .where('products.game_id', '=', options.gameId)
    .where((eb) =>
      eb.or([
        eb('entitlements.expires_at', 'is', null),
        eb('entitlements.expires_at', '>', options.now),
      ]),
    )
    .execute();
  const kept = new Map<string, OwnedRow>();
  for (const row of rows) {
    const existing = kept.get(row.slug);
    if (!existing) {
      kept.set(row.slug, { slug: row.slug, type: row.type, expires_at: row.expires_at });
      continue;
    }
    if (existing.expires_at === null || row.expires_at === null) {
      kept.set(row.slug, { slug: row.slug, type: row.type, expires_at: null });
    } else if (row.expires_at > existing.expires_at) {
      existing.expires_at = row.expires_at;
    }
  }
  return [...kept.values()].sort((left, right) => left.slug.localeCompare(right.slug));
}

export type IssueOutcome =
  | { status: 'ok'; lease: LeaseRecord }
  | { status: 'not_owned' }
  | { status: 'device_required' }
  | { status: 'device_limit' };

export async function issueLease(
  db: Kysely<Database>,
  options: {
    userId: string;
    gameId: string;
    gameSlug: string;
    deviceBinding: boolean;
    deviceId: string | null;
    deviceLabel: string | null;
    maxDevices: number;
    duration: number;
    actor: EventActor;
    now: Date;
  },
): Promise<IssueOutcome> {
  const owned = await ownedProductsForGame(db, {
    userId: options.userId,
    gameId: options.gameId,
    now: options.now,
  });
  if (owned.length === 0) return { status: 'not_owned' };
  if (options.deviceBinding && options.deviceId === null) return { status: 'device_required' };
  const deviceHash = options.deviceId === null ? null : hashDeviceId(options.deviceId);
  const products: LeasedProduct[] = owned.map((row) => ({
    slug: row.slug,
    type: row.type,
    expires_at: row.expires_at?.toISOString() ?? null,
  }));
  return db.transaction().execute(async (trx) => {
    if (options.deviceBinding) {
      if (deviceHash !== null) {
        await trx
          .updateTable('license_leases')
          .set({ revoked_at: options.now, revoke_reason: 'renewed' })
          .where('user_id', '=', options.userId)
          .where('game_id', '=', options.gameId)
          .where('device_hash', '=', deviceHash)
          .where('revoked_at', 'is', null)
          .execute();
      }
      const active = await trx
        .selectFrom('license_leases')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('user_id', '=', options.userId)
        .where('game_id', '=', options.gameId)
        .where('revoked_at', 'is', null)
        .where('expires_at', '>', options.now)
        .executeTakeFirstOrThrow();
      if (Number(active.count) >= options.maxDevices) return { status: 'device_limit' as const };
    }
    const id = randomUUID();
    const expiresAt = new Date(options.now.getTime() + options.duration);
    await trx
      .insertInto('license_leases')
      .values({
        id,
        user_id: options.userId,
        game_id: options.gameId,
        device_hash: deviceHash,
        device_label: options.deviceLabel,
        products,
        issued_at: options.now,
        expires_at: expiresAt,
        revoked_at: null,
        revoke_reason: null,
        last_seen_at: null,
        created_at: options.now,
      })
      .execute();
    const data: LicenseLeaseIssuedData = {
      lease_id: id,
      user_id: options.userId,
      game_id: options.gameId,
      device_bound: options.deviceBinding,
      product_count: products.length,
      issued_at: options.now.toISOString(),
      expires_at: expiresAt.toISOString(),
    };
    await writeEvent<Database, LicenseLeaseIssuedData>(
      trx,
      licenseLeaseIssuedEvent(data, options.actor),
    );
    await writeAudit(trx, options.actor, 'games.license.issued', id);
    return {
      status: 'ok' as const,
      lease: {
        id,
        user_id: options.userId,
        game_id: options.gameId,
        device_hash: deviceHash,
        device_label: options.deviceLabel,
        products,
        issued_at: options.now,
        expires_at: expiresAt,
        revoked_at: null,
        revoke_reason: null,
        last_seen_at: null,
        created_at: options.now,
      },
    };
  });
}

function leaseFromRow(row: Selectable<LicenseLeasesTable>): LeaseRecord {
  return row;
}

export async function getLease(
  db: Kysely<Database>,
  leaseId: string,
): Promise<LeaseRecord | undefined> {
  const row = await db
    .selectFrom('license_leases')
    .selectAll()
    .where('id', '=', leaseId)
    .executeTakeFirst();
  return row ? leaseFromRow(row) : undefined;
}

export interface LeaseListOptions {
  gameId?: string;
  userId?: string;
  activeOnly?: boolean;
  after?: { issued_at: string; id: string };
  limit: number;
  now: Date;
}

export async function listLeases(
  db: Kysely<Database>,
  options: LeaseListOptions,
): Promise<LeaseRecord[]> {
  let query = db.selectFrom('license_leases').selectAll();
  if (options.gameId !== undefined) query = query.where('game_id', '=', options.gameId);
  if (options.userId !== undefined) query = query.where('user_id', '=', options.userId);
  if (options.activeOnly === true) {
    query = query.where('revoked_at', 'is', null).where('expires_at', '>', options.now);
  }
  const after = options.after;
  if (after !== undefined) {
    const issuedAt = new Date(after.issued_at);
    query = query.where((eb) =>
      eb.or([
        eb('issued_at', '<', issuedAt),
        eb.and([eb('issued_at', '=', issuedAt), eb('id', '<', after.id)]),
      ]),
    );
  }
  const rows = await query
    .orderBy('issued_at', 'desc')
    .orderBy('id', 'desc')
    .limit(options.limit)
    .execute();
  return rows.map(leaseFromRow);
}

export type RevokeOutcome =
  { status: 'ok'; lease: LeaseRecord } | { status: 'not_found' } | { status: 'revoked' };

export async function revokeLease(
  db: Kysely<Database>,
  options: { leaseId: string; reason: string; actor: EventActor; now: Date },
): Promise<RevokeOutcome> {
  return db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom('license_leases')
      .selectAll()
      .where('id', '=', options.leaseId)
      .executeTakeFirst();
    if (!row) return { status: 'not_found' as const };
    if (row.revoked_at !== null) return { status: 'revoked' as const };
    const result = await trx
      .updateTable('license_leases')
      .set({ revoked_at: options.now, revoke_reason: options.reason })
      .where('id', '=', options.leaseId)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    if (updatedRows(result) !== 1) return { status: 'revoked' as const };
    await trx
      .insertInto('license_revocations')
      .values({
        lease_id: row.id,
        game_id: row.game_id,
        user_id: row.user_id,
        revoked_at: options.now,
        expires_at: row.expires_at,
        reason: options.reason,
      })
      .execute();
    const revoked = leaseFromRow({
      ...row,
      revoked_at: options.now,
      revoke_reason: options.reason,
    });
    const data: LicenseLeaseRevokedData = {
      lease_id: revoked.id,
      user_id: revoked.user_id,
      game_id: revoked.game_id,
      reason: options.reason,
    };
    await writeEvent<Database, LicenseLeaseRevokedData>(
      trx,
      licenseLeaseRevokedEvent(data, options.actor),
    );
    await writeAudit(trx, options.actor, 'games.license.revoked', revoked.id);
    return { status: 'ok' as const, lease: revoked };
  });
}

export async function touchLease(
  db: Kysely<Database>,
  options: { leaseId: string; now: Date },
): Promise<void> {
  await db
    .updateTable('license_leases')
    .set({ last_seen_at: options.now })
    .where('id', '=', options.leaseId)
    .execute();
}

export async function listRevocations(
  db: Kysely<Database>,
  options: { gameId?: string; since: Date | null; now: Date; limit: number },
): Promise<{ jti: string; game_id: string; revoked_at: Date; expires_at: Date }[]> {
  let query = db
    .selectFrom('license_revocations')
    .select(['lease_id', 'game_id', 'revoked_at', 'expires_at'])
    .where('expires_at', '>', options.now);
  if (options.gameId !== undefined) query = query.where('game_id', '=', options.gameId);
  if (options.since !== null) query = query.where('revoked_at', '>', options.since);
  const rows = await query.orderBy('revoked_at', 'asc').limit(options.limit).execute();
  return rows.map((row) => ({
    jti: row.lease_id,
    game_id: row.game_id,
    revoked_at: row.revoked_at,
    expires_at: row.expires_at,
  }));
}

export async function sweepExpiredRevocations(db: Kysely<Database>, now: Date): Promise<number> {
  const result = await db
    .deleteFrom('license_revocations')
    .where('expires_at', '<=', now)
    .executeTakeFirst();
  return Number(result.numDeletedRows);
}

export async function eraseUserLeases(db: Kysely<Database>, userId: string): Promise<void> {
  const now = new Date();
  const rows = await db
    .selectFrom('license_leases')
    .select(['id', 'game_id', 'expires_at'])
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null)
    .execute();
  for (const row of rows) {
    await db
      .insertInto('license_revocations')
      .values({
        lease_id: row.id,
        game_id: row.game_id,
        user_id: userId,
        revoked_at: now,
        expires_at: row.expires_at,
        reason: 'user_erased',
      })
      .execute();
  }
  await db.deleteFrom('license_leases').where('user_id', '=', userId).execute();
}

export async function exportUserLeases(
  db: Kysely<Database>,
  userId: string,
): Promise<Record<string, unknown>[]> {
  const rows = await db
    .selectFrom('license_leases')
    .innerJoin('games', 'games.id', 'license_leases.game_id')
    .select([
      'license_leases.id as id',
      'games.slug as game_slug',
      'license_leases.device_label as device_label',
      'license_leases.products as products',
      'license_leases.issued_at as issued_at',
      'license_leases.expires_at as expires_at',
      'license_leases.revoked_at as revoked_at',
      'license_leases.revoke_reason as revoke_reason',
    ])
    .where('license_leases.user_id', '=', userId)
    .orderBy('license_leases.issued_at', 'desc')
    .execute();
  return rows.map((row) => ({
    id: row.id,
    game_slug: row.game_slug,
    device_label: row.device_label,
    products: row.products,
    issued_at: row.issued_at.toISOString(),
    expires_at: row.expires_at.toISOString(),
    revoked_at: row.revoked_at?.toISOString() ?? null,
    revoke_reason: row.revoke_reason,
  }));
}
