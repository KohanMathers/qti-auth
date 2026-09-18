import { writeEvent } from '@qtiauth/bus';
import { updatedRows } from '@qtiauth/db';
import { queueEmail } from '@qtiauth/email';
import type { EventActor } from '@qtiauth/events';
import { sql, type Kysely } from 'kysely';

import type { Database, LegalAcceptanceMethod } from './database.ts';
import {
  type AuditRecordedData,
  auditRecordedEvent,
  type LegalVersionPublishedData,
  legalVersionPublishedEvent,
  type UserUpdatedData,
  userUpdatedEvent,
} from './events.ts';
import { hasActiveGuardians, listActiveGuardians } from './family.ts';
import {
  interpolateLegal,
  LegalDocumentsError,
  loadLegalDocuments,
  type ParsedLegalDocument,
} from './legal-documents.ts';
import type { IdentityConfig } from './service.ts';
import { accountOrigin, accountPath, familyChildUrl } from './settings.ts';

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

const VERSION_COLUMNS = ['id', 'version', 'effective_at', 'material', 'summary', 'body'] as const;

// The one definition of "current": the effective version with the latest effective_at, then the
// highest version string. Every query below builds on this.
function currentVersionsQuery(db: Kysely<Database>, now: Date) {
  return db
    .selectFrom('legal_versions')
    .distinctOn('id')
    .select(VERSION_COLUMNS)
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
    .select(VERSION_COLUMNS)
    .where('id', '=', id)
    .where('version', '=', version)
    .executeTakeFirst();
}

export async function findCurrentLegalVersion(
  db: Kysely<Database>,
  id: string,
  now: Date,
): Promise<LegalVersion | undefined> {
  return currentVersionsQuery(db, now).where('id', '=', id).executeTakeFirst();
}

// A version at or before now can be viewed if it is current, or if history is public.
export async function findViewableLegalVersion(
  db: Kysely<Database>,
  options: { id: string; version: string; publicHistory: boolean; now: Date },
): Promise<LegalVersion | undefined> {
  const [document, current] = await Promise.all([
    findLegalVersion(db, options.id, options.version),
    findCurrentLegalVersion(db, options.id, options.now),
  ]);
  if (!document || document.effective_at.getTime() > options.now.getTime()) return undefined;
  if (!options.publicHistory && current?.version !== document.version) return undefined;
  return document;
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
  if (await hasActiveGuardians(db, userId)) return false;
  const pending = await db
    .selectFrom(currentVersionsQuery(db, now).as('v'))
    .select('v.id')
    .where('v.material', '=', true)
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
          .selectFrom(currentVersionsQuery(db, now).as('v'))
          .select(sql`1`.as('ok'))
          .where('v.material', '=', true)
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

export async function acceptLegalDocuments(
  db: Kysely<Database>,
  options: {
    userId: string;
    documents: readonly { id: string; version: string }[];
    ip: string | null;
    now: Date;
  },
): Promise<{ status: 'ok'; accepted: number } | { status: 'unknown' }> {
  return db.transaction().execute(async (trx) => {
    const result = await acceptLegalVersions(trx, { ...options, method: 'self' });
    if (result.unknown.length > 0) return { status: 'unknown' as const };
    const actor: EventActor = { type: 'user', id: options.userId };
    for (const document of options.documents) {
      await writeEvent<Database, AuditRecordedData>(
        trx,
        auditRecordedEvent(actor, {
          action: 'legal.accepted',
          target_type: 'legal_version',
          target_id: `${document.id}:${document.version}`,
        }),
      );
    }
    if (result.accepted > 0) {
      await writeEvent<Database, UserUpdatedData>(
        trx,
        userUpdatedEvent(options.userId, { fields: ['legal'] }, actor),
      );
    }
    return { status: 'ok' as const, accepted: result.accepted };
  });
}

export async function acceptLegalAsGuardian(
  db: Kysely<Database>,
  options: {
    childUserId: string;
    documents: readonly { id: string; version: string }[];
    ip: string | null;
    actor: EventActor;
    now: Date;
  },
): Promise<{ status: 'ok'; accepted: number } | { status: 'unknown' }> {
  return db.transaction().execute(async (trx) => {
    const result = await acceptLegalVersions(trx, {
      userId: options.childUserId,
      documents: options.documents,
      ip: options.ip,
      method: 'guardian',
      now: options.now,
    });
    if (result.unknown.length > 0) return { status: 'unknown' as const };
    for (const document of options.documents) {
      await writeEvent<Database, AuditRecordedData>(
        trx,
        auditRecordedEvent(options.actor, {
          action: 'legal.accepted',
          target_type: 'legal_version',
          target_id: `${document.id}:${document.version}`,
        }),
      );
    }
    if (result.accepted > 0) {
      await writeEvent<Database, UserUpdatedData>(
        trx,
        userUpdatedEvent(options.childUserId, { fields: ['legal'] }, options.actor),
      );
    }
    return { status: 'ok' as const, accepted: result.accepted };
  });
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
  options: { now: Date },
): Promise<LegalVersion[]> {
  const pending = await db
    .selectFrom('legal_versions')
    .select(VERSION_COLUMNS)
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
        .set({
          published_at: options.now,
          notices_sent_at: null,
        })
        .where('id', '=', version.id)
        .where('version', '=', version.version)
        .where('published_at', 'is', null)
        .executeTakeFirst();
      if (updatedRows(updated) === 0) return false;
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
      return true;
    });
    if (claimed) published.push(version);
  }
  return published;
}

export const LEGAL_NOTICE_BATCH = 500;

async function queueNoticeBatch(
  db: Kysely<Database>,
  options: {
    version: LegalVersion & { notice_cursor: string | null };
    config: IdentityConfig;
    bus: Parameters<typeof queueEmail>[0];
  },
): Promise<{ sent: number; cursor: string | null; done: boolean }> {
  const { version } = options;
  let query = db
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
            .where('document_id', '=', version.id)
            .where('version', '=', version.version),
        ),
      ),
    );
  if (version.notice_cursor !== null) query = query.where('id', '>', version.notice_cursor);
  const recipients = await query.orderBy('id').limit(LEGAL_NOTICE_BATCH).execute();
  const link = legalDocumentUrl(options.config, version.id, version.version);
  const summary = interpolateLegal(version.summary, options.config.branding);
  let sent = 0;
  for (const user of recipients) {
    const guardians = await listActiveGuardians(db, user.id);
    if (guardians.length > 0) {
      const familyLink = familyChildUrl(options.config, user.id);
      for (const guardian of guardians) {
        await queueEmail(options.bus, {
          template: 'guardian_legal_update',
          to: { address: guardian.email },
          locale: user.locale ?? options.config.email.default_locale,
          userId: guardian.user_id,
          variables: {
            document_id: version.id,
            version: version.version,
            summary,
            material: version.material,
            link,
            family_link: familyLink,
          },
        });
        sent += 1;
      }
      continue;
    }
    if (version.material) continue;
    await queueEmail(options.bus, {
      template: 'legal_update',
      to: { address: user.email },
      locale: user.locale ?? options.config.email.default_locale,
      userId: user.id,
      variables: { document_id: version.id, version: version.version, summary, link },
    });
    sent += 1;
  }
  const last = recipients.at(-1);
  const done = recipients.length < LEGAL_NOTICE_BATCH;
  // Saving progress after each batch means a restart resumes here instead of re-sending.
  await db
    .updateTable('legal_versions')
    .set({
      ...(last === undefined ? {} : { notice_cursor: last.id }),
      ...(done ? { notices_sent_at: new Date() } : {}),
    })
    .where('id', '=', version.id)
    .where('version', '=', version.version)
    .execute();
  return { sent, cursor: last?.id ?? version.notice_cursor, done };
}

export async function queueLegalUpdateNotices(
  db: Kysely<Database>,
  options: { config: IdentityConfig; bus: Parameters<typeof queueEmail>[0] },
): Promise<number> {
  const versions = await db
    .selectFrom('legal_versions')
    .select([...VERSION_COLUMNS, 'notice_cursor'])
    .where('published_at', 'is not', null)
    .where('notices_sent_at', 'is', null)
    .orderBy('published_at')
    .execute();
  let sent = 0;
  for (const version of versions) {
    let cursor = version.notice_cursor;
    for (;;) {
      const batch = await queueNoticeBatch(db, {
        version: { ...version, notice_cursor: cursor },
        config: options.config,
        bus: options.bus,
      });
      sent += batch.sent;
      if (batch.done) break;
      cursor = batch.cursor;
    }
  }
  return sent;
}

export async function loadAndSyncLegalDocuments(
  db: Kysely<Database>,
  dir: string,
): Promise<{ documents: number; inserted: number }> {
  const documents = await loadLegalDocuments(dir);
  const inserted = await syncLegalDocuments(db, documents);
  return { documents: documents.length, inserted };
}
