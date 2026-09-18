import { writeEvent } from '@qtiauth/bus';
import { queueEmail } from '@qtiauth/email';
import { sql, type Kysely } from 'kysely';

import type { Database, LegalAcceptanceMethod } from './database.ts';
import { type LegalVersionPublishedData, legalVersionPublishedEvent } from './events.ts';
import {
  interpolateLegal,
  type LegalBrand,
  LegalDocumentsError,
  loadLegalDocuments,
  type ParsedLegalDocument,
} from './legal-documents.ts';
import type { IdentityConfig } from './service.ts';
import { accountOrigin, accountPath } from './settings.ts';

export const LEGAL_PUBLISH_JOB = 'legal.publish';

export interface LegalVersion {
  id: string;
  version: string;
  effective_at: Date;
  material: boolean;
  summary: string;
  body: string;
}

export interface LegalAcceptance {
  document_id: string;
  version: string;
  accepted_at: Date;
  ip: string | null;
  method: LegalAcceptanceMethod;
}

function currentVersionsQuery(db: Kysely<Database>, now: Date) {
  return db
    .selectFrom('legal_versions')
    .distinctOn('id')
    .select(['id', 'version', 'effective_at', 'material', 'summary', 'body'])
    .where('effective_at', '<=', now)
    .orderBy('id')
    .orderBy('effective_at', 'desc')
    .orderBy('version', 'desc');
}

export async function currentLegalVersions(
  db: Kysely<Database>,
  now: Date,
): Promise<LegalVersion[]> {
  return currentVersionsQuery(db, now).execute();
}

export async function findLegalVersion(
  db: Kysely<Database>,
  id: string,
  version: string,
): Promise<LegalVersion | undefined> {
  return db
    .selectFrom('legal_versions')
    .select(['id', 'version', 'effective_at', 'material', 'summary', 'body'])
    .where('id', '=', id)
    .where('version', '=', version)
    .executeTakeFirst();
}

export async function findCurrentLegalVersion(
  db: Kysely<Database>,
  id: string,
  now: Date,
): Promise<LegalVersion | undefined> {
  return db
    .selectFrom('legal_versions')
    .select(['id', 'version', 'effective_at', 'material', 'summary', 'body'])
    .where('id', '=', id)
    .where('effective_at', '<=', now)
    .orderBy('effective_at', 'desc')
    .orderBy('version', 'desc')
    .executeTakeFirst();
}

export async function pendingMaterialVersions(
  db: Kysely<Database>,
  userId: string,
  now: Date,
): Promise<LegalVersion[]> {
  const current = await currentLegalVersions(db, now);
  const material = current.filter((document) => document.material);
  if (material.length === 0) return [];
  const accepted = await db
    .selectFrom('legal_acceptances')
    .select(['document_id', 'version'])
    .where('user_id', '=', userId)
    .where(
      'document_id',
      'in',
      material.map((document) => document.id),
    )
    .execute();
  const acceptedKeys = new Set(accepted.map((row) => `${row.document_id}\0${row.version}`));
  return material.filter((document) => !acceptedKeys.has(`${document.id}\0${document.version}`));
}

export async function legalAcceptanceRequired(
  db: Kysely<Database>,
  userId: string,
  now: Date,
): Promise<boolean> {
  const pending = await db
    .selectFrom('legal_versions as v')
    .select(sql<number>`1`.as('ok'))
    .where('v.effective_at', '<=', now)
    .where('v.material', '=', true)
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('legal_versions as newer')
            .select(sql`1`.as('ok'))
            .whereRef('newer.id', '=', 'v.id')
            .where('newer.effective_at', '<=', now)
            .where((inner) =>
              inner.or([
                inner('newer.effective_at', '>', inner.ref('v.effective_at')),
                inner.and([
                  inner('newer.effective_at', '=', inner.ref('v.effective_at')),
                  inner('newer.version', '>', inner.ref('v.version')),
                ]),
              ]),
            ),
        ),
      ),
    )
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('legal_acceptances as a')
            .select(sql`1`.as('ok'))
            .where('a.user_id', '=', userId)
            .whereRef('a.document_id', '=', 'v.id')
            .whereRef('a.version', '=', 'v.version'),
        ),
      ),
    )
    .limit(1)
    .executeTakeFirst();
  return pending !== undefined;
}

export async function countPendingLegalAcceptances(
  db: Kysely<Database>,
  now: Date,
): Promise<number> {
  const row = await db
    .selectFrom('users as u')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('u.state', '!=', 'deleted')
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom('legal_versions as v')
          .select(sql`1`.as('ok'))
          .where('v.effective_at', '<=', now)
          .where('v.material', '=', true)
          .where((inner) =>
            inner.not(
              inner.exists(
                inner
                  .selectFrom('legal_versions as newer')
                  .select(sql`1`.as('ok'))
                  .whereRef('newer.id', '=', 'v.id')
                  .where('newer.effective_at', '<=', now)
                  .where((newest) =>
                    newest.or([
                      newest('newer.effective_at', '>', newest.ref('v.effective_at')),
                      newest.and([
                        newest('newer.effective_at', '=', newest.ref('v.effective_at')),
                        newest('newer.version', '>', newest.ref('v.version')),
                      ]),
                    ]),
                  ),
              ),
            ),
          )
          .where((inner) =>
            inner.not(
              inner.exists(
                inner
                  .selectFrom('legal_acceptances as a')
                  .select(sql`1`.as('ok'))
                  .whereRef('a.user_id', '=', 'u.id')
                  .whereRef('a.document_id', '=', 'v.id')
                  .whereRef('a.version', '=', 'v.version'),
              ),
            ),
          ),
      ),
    )
    .executeTakeFirst();
  return Number(row?.count ?? 0);
}

export async function listLegalAcceptances(
  db: Kysely<Database>,
  userId: string,
): Promise<LegalAcceptance[]> {
  return db
    .selectFrom('legal_acceptances')
    .select(['document_id', 'version', 'accepted_at', 'ip', 'method'])
    .where('user_id', '=', userId)
    .orderBy('accepted_at')
    .orderBy('document_id')
    .execute();
}

function sameInstant(left: Date, right: Date): boolean {
  return left.getTime() === right.getTime();
}

export async function syncLegalDocuments(
  db: Kysely<Database>,
  documents: readonly ParsedLegalDocument[],
): Promise<number> {
  let inserted = 0;
  for (const document of documents) {
    const existing = await db
      .selectFrom('legal_versions')
      .select(['body_hash', 'summary', 'material', 'effective_at'])
      .where('id', '=', document.id)
      .where('version', '=', document.version)
      .executeTakeFirst();
    if (existing) {
      if (
        existing.body_hash !== document.bodyHash ||
        existing.summary !== document.summary ||
        existing.material !== document.material ||
        !sameInstant(existing.effective_at, document.effectiveAt)
      ) {
        throw new LegalDocumentsError(
          `Legal document ${document.file} version ${document.version} changed without a version bump`,
        );
      }
      continue;
    }
    await db
      .insertInto('legal_versions')
      .values({
        id: document.id,
        version: document.version,
        effective_at: document.effectiveAt,
        material: document.material,
        summary: document.summary,
        body: document.body,
        body_hash: document.bodyHash,
        published_at: null,
      })
      .execute();
    inserted += 1;
  }
  return inserted;
}

export async function recordCurrentLegalAcceptances(
  db: Kysely<Database>,
  options: {
    userId: string;
    ip: string | null;
    method: LegalAcceptanceMethod;
    now: Date;
  },
): Promise<void> {
  const current = await currentLegalVersions(db, options.now);
  if (current.length === 0) return;
  await db
    .insertInto('legal_acceptances')
    .values(
      current.map((document) => ({
        user_id: options.userId,
        document_id: document.id,
        version: document.version,
        accepted_at: options.now,
        ip: options.ip,
        method: options.method,
      })),
    )
    .onConflict((conflict) => conflict.columns(['user_id', 'document_id', 'version']).doNothing())
    .execute();
}

export async function acceptLegalVersions(
  db: Kysely<Database>,
  options: {
    userId: string;
    documents: readonly { id: string; version: string }[];
    ip: string | null;
    method: LegalAcceptanceMethod;
    now: Date;
  },
): Promise<{ accepted: number; unknown: { id: string; version: string }[] }> {
  if (options.documents.length === 0) return { accepted: 0, unknown: [] };
  const unknown: { id: string; version: string }[] = [];
  const rows: {
    user_id: string;
    document_id: string;
    version: string;
    accepted_at: Date;
    ip: string | null;
    method: LegalAcceptanceMethod;
  }[] = [];
  for (const document of options.documents) {
    const existing = await findLegalVersion(db, document.id, document.version);
    if (!existing || existing.effective_at.getTime() > options.now.getTime()) {
      unknown.push(document);
    } else {
      rows.push({
        user_id: options.userId,
        document_id: document.id,
        version: document.version,
        accepted_at: options.now,
        ip: options.ip,
        method: options.method,
      });
    }
  }
  if (unknown.length > 0) return { accepted: 0, unknown };
  if (rows.length > 0) {
    await db
      .insertInto('legal_acceptances')
      .values(rows)
      .onConflict((conflict) => conflict.columns(['user_id', 'document_id', 'version']).doNothing())
      .execute();
  }
  return { accepted: rows.length, unknown };
}

export function legalDocumentUrl(
  config: Pick<IdentityConfig, 'surfaces'>,
  id: string,
  version: string,
): string {
  return new URL(
    accountPath(config, `/legal/${encodeURIComponent(id)}/${encodeURIComponent(version)}`),
    accountOrigin(config),
  ).toString();
}

export async function publishLegalVersions(
  db: Kysely<Database>,
  options: {
    now: Date;
    queueNotice?: (version: LegalVersion) => Promise<void>;
  },
): Promise<LegalVersion[]> {
  const pending = await db
    .selectFrom('legal_versions')
    .select(['id', 'version', 'effective_at', 'material', 'summary', 'body'])
    .where('effective_at', '<=', options.now)
    .where('published_at', 'is', null)
    .orderBy('effective_at')
    .orderBy('id')
    .orderBy('version')
    .execute();
  const published: LegalVersion[] = [];
  for (const version of pending) {
    const claimed = await db.transaction().execute(async (trx) => {
      const updated = await trx
        .updateTable('legal_versions')
        .set({ published_at: options.now })
        .where('id', '=', version.id)
        .where('version', '=', version.version)
        .where('published_at', 'is', null)
        .executeTakeFirst();
      if (Number(updated.numUpdatedRows) === 0) return false;
      await writeEvent<Database, LegalVersionPublishedData>(
        trx,
        legalVersionPublishedEvent({
          id: version.id,
          version: version.version,
          effective_at: version.effective_at.toISOString(),
          material: version.material,
          summary: version.summary,
        }),
      );
      published.push(version);
      return true;
    });
    if (claimed && !version.material) await options.queueNotice?.(version);
  }
  return published;
}

export async function queueLegalUpdateNotices(
  db: Kysely<Database>,
  options: {
    version: LegalVersion;
    config: IdentityConfig;
    bus: Parameters<typeof queueEmail>[0];
    brand: LegalBrand;
  },
): Promise<number> {
  const recipients = await db
    .selectFrom('users')
    .select(['id', 'email', 'locale'])
    .where('state', '!=', 'deleted')
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('legal_acceptances')
            .select(sql`1`.as('ok'))
            .whereRef('legal_acceptances.user_id', '=', 'users.id')
            .where('document_id', '=', options.version.id)
            .where('version', '=', options.version.version),
        ),
      ),
    )
    .execute();
  const link = legalDocumentUrl(options.config, options.version.id, options.version.version);
  const summary = interpolateLegal(options.version.summary, options.brand);
  for (const user of recipients) {
    await queueEmail(options.bus, {
      template: 'legal_update',
      to: { address: user.email },
      locale: user.locale ?? options.config.email.default_locale,
      userId: user.id,
      variables: {
        document_id: options.version.id,
        version: options.version.version,
        summary,
        link,
      },
    });
  }
  return recipients.length;
}

export async function loadAndSyncLegalDocuments(
  db: Kysely<Database>,
  dir: string,
): Promise<{ documents: number; inserted: number }> {
  const documents = await loadLegalDocuments(dir);
  const inserted = await syncLegalDocuments(db, documents);
  return { documents: documents.length, inserted };
}
