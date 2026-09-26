import { randomUUID } from 'node:crypto';

import { writeEvent } from '@qtiauth/bus';
import type { EventActor } from '@qtiauth/events';
import type { ObjectStore } from '@qtiauth/service-kit';
import { type Kysely, sql } from 'kysely';

import type { Database, KbStatus } from './database.ts';
import { type AuditRecordedData, auditRecordedEvent } from './events.ts';
import { decodeBase64, sniffAttachment } from './sniff.ts';

export const KB_TITLE_MAX = 200;
export const KB_BODY_MAX = 100_000;
export const KB_SLUG_MAX = 80;
export const KB_NAME_MAX = 80;
export const KB_ICON_MAX = 40;
export const KB_TAG_MAX = 40;
export const KB_TAGS_MAX = 16;
export const KB_ORDER_MAX = 10_000;
export const KB_SEARCH_LIMIT = 25;
export const KB_RELATED_LIMIT = 5;
export const KB_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const KB_TAG = /^[a-z0-9]+(?:[ -][a-z0-9]+)*$/;

const ARTICLE_COLUMNS = [
  'id',
  'category_id',
  'slug',
  'title',
  'body',
  'status',
  'tags',
  'published_at',
  'created_by',
  'updated_by',
  'created_at',
  'updated_at',
] as const;

export interface KbCategoryRecord {
  id: string;
  slug: string;
  name: string;
  icon: string | null;
  display_order: number;
  created_at: Date;
  updated_at: Date;
}

export interface KbArticleRecord {
  id: string;
  category_id: string;
  slug: string;
  title: string;
  body: string;
  status: KbStatus;
  tags: string[];
  published_at: Date | null;
  created_by: string;
  updated_by: string;
  created_at: Date;
  updated_at: Date;
}

export interface KbRevisionRecord {
  id: string;
  article_id: string;
  revision: number;
  title: string;
  body: string;
  tags: string[];
  slug: string;
  category_id: string;
  status: KbStatus;
  author_id: string;
  created_at: Date;
}

export interface KbImageRecord {
  id: string;
  object_key: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  created_by: string;
  created_at: Date;
}

export interface NormalizedCategory {
  slug: string;
  name: string;
  icon: string | null;
  displayOrder: number;
}

export interface NormalizedArticle {
  categoryId: string;
  slug: string;
  title: string;
  body: string;
  tags: string[];
  status: KbStatus;
}

export function kbImagePath(id: string): string {
  return `/api/v1/support/kb/images/${id}`;
}

export function kbImageObjectKey(id: string): string {
  return `kb/${id}`;
}

function validIcon(icon: string): string | undefined {
  const value = icon.trim();
  if (value.length === 0 || value.length > KB_ICON_MAX) return undefined;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f || char === '<' || char === '>') return undefined;
  }
  return value;
}

export function normalizeCategory(input: {
  slug: string;
  name: string;
  icon: string | null;
  displayOrder: number;
}): NormalizedCategory | undefined {
  const slug = input.slug.trim().toLowerCase();
  const name = input.name.trim();
  if (!KB_SLUG.test(slug) || slug.length > KB_SLUG_MAX) return undefined;
  if (name.length === 0 || name.length > KB_NAME_MAX) return undefined;
  if (
    !Number.isInteger(input.displayOrder) ||
    input.displayOrder < 0 ||
    input.displayOrder > KB_ORDER_MAX
  ) {
    return undefined;
  }
  if (input.icon === null) return { slug, name, icon: null, displayOrder: input.displayOrder };
  const icon = validIcon(input.icon);
  if (icon === undefined) return undefined;
  return { slug, name, icon, displayOrder: input.displayOrder };
}

function normalizeTags(tags: readonly string[]): string[] | undefined {
  if (tags.length > KB_TAGS_MAX) return undefined;
  const normalized: string[] = [];
  for (const tag of tags) {
    const value = tag.trim().toLowerCase().replaceAll(/\s+/g, ' ');
    if (value.length > KB_TAG_MAX || !KB_TAG.test(value)) return undefined;
    if (!normalized.includes(value)) normalized.push(value);
  }
  return normalized;
}

export function normalizeArticle(input: {
  categoryId: string;
  slug: string;
  title: string;
  body: string;
  tags: readonly string[];
  status: KbStatus;
}): NormalizedArticle | undefined {
  const slug = input.slug.trim().toLowerCase();
  const title = input.title.trim();
  if (!KB_SLUG.test(slug) || slug.length > KB_SLUG_MAX) return undefined;
  if (title.length === 0 || title.length > KB_TITLE_MAX) return undefined;
  if (input.body.length > KB_BODY_MAX) return undefined;
  const tags = normalizeTags(input.tags);
  if (tags === undefined) return undefined;
  return {
    categoryId: input.categoryId,
    slug,
    title,
    body: input.body,
    tags,
    status: input.status,
  };
}

function tsQuery(text: string, operator: '&' | '|'): string | undefined {
  const words = [
    ...new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word.length > 1),
    ),
  ].slice(0, 32);
  if (words.length === 0) return undefined;
  return words.join(` ${operator} `);
}

async function writeAudit(
  db: Kysely<Database>,
  actorId: string,
  action: string,
  targetType: string,
  targetId: string,
): Promise<void> {
  const actor: EventActor = { type: 'user', id: actorId };
  await writeEvent<Database, AuditRecordedData>(
    db,
    auditRecordedEvent(actor, { action, target_type: targetType, target_id: targetId }),
  );
}

async function writeSearchVector(db: Kysely<Database>, id: string): Promise<void> {
  await sql`
    update kb_articles
    set search_vector =
      setweight(to_tsvector('simple', title), 'A') ||
      setweight(to_tsvector('simple', array_to_string(tags, ' ')), 'B') ||
      setweight(to_tsvector('simple', body), 'C')
    where id = ${id}
  `.execute(db);
}

async function categorySlugTaken(
  db: Kysely<Database>,
  slug: string,
  exceptId?: string,
): Promise<boolean> {
  let query = db.selectFrom('kb_categories').select('id').where('slug', '=', slug);
  if (exceptId !== undefined) query = query.where('id', '<>', exceptId);
  return (await query.executeTakeFirst()) !== undefined;
}

async function articleSlugTaken(
  db: Kysely<Database>,
  slug: string,
  exceptId?: string,
): Promise<boolean> {
  let query = db.selectFrom('kb_articles').select('id').where('slug', '=', slug);
  if (exceptId !== undefined) query = query.where('id', '<>', exceptId);
  return (await query.executeTakeFirst()) !== undefined;
}

async function nextRevision(db: Kysely<Database>, articleId: string): Promise<number> {
  const row = await db
    .selectFrom('kb_revisions')
    .select((eb) => eb.fn.max<string | number | null>('revision').as('revision'))
    .where('article_id', '=', articleId)
    .executeTakeFirst();
  return Number(row?.revision ?? 0) + 1;
}

async function insertRevision(
  db: Kysely<Database>,
  article: KbArticleRecord,
  authorId: string,
  now: Date,
): Promise<number> {
  const revision = await nextRevision(db, article.id);
  await db
    .insertInto('kb_revisions')
    .values({
      id: randomUUID(),
      article_id: article.id,
      revision,
      title: article.title,
      body: article.body,
      tags: article.tags,
      slug: article.slug,
      category_id: article.category_id,
      status: article.status,
      author_id: authorId,
      created_at: now,
    })
    .execute();
  return revision;
}

function sameArticle(article: KbArticleRecord, next: NormalizedArticle): boolean {
  return (
    article.category_id === next.categoryId &&
    article.slug === next.slug &&
    article.title === next.title &&
    article.body === next.body &&
    article.status === next.status &&
    article.tags.join('\u0000') === next.tags.join('\u0000')
  );
}

export async function listCategories(db: Kysely<Database>): Promise<KbCategoryRecord[]> {
  return db
    .selectFrom('kb_categories')
    .selectAll()
    .orderBy('display_order', 'asc')
    .orderBy('name', 'asc')
    .orderBy('id', 'asc')
    .execute();
}

export async function listPublicCategories(db: Kysely<Database>): Promise<KbCategoryRecord[]> {
  return db
    .selectFrom('kb_categories')
    .selectAll('kb_categories')
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom('kb_articles')
          .select('id')
          .whereRef('kb_articles.category_id', '=', 'kb_categories.id')
          .where('status', '=', 'published'),
      ),
    )
    .orderBy('display_order', 'asc')
    .orderBy('name', 'asc')
    .orderBy('id', 'asc')
    .execute();
}

export async function getCategory(
  db: Kysely<Database>,
  id: string,
): Promise<KbCategoryRecord | undefined> {
  return db.selectFrom('kb_categories').selectAll().where('id', '=', id).executeTakeFirst();
}

export async function getCategoryBySlug(
  db: Kysely<Database>,
  slug: string,
): Promise<KbCategoryRecord | undefined> {
  return db.selectFrom('kb_categories').selectAll().where('slug', '=', slug).executeTakeFirst();
}

export async function hasPublishedArticle(
  db: Kysely<Database>,
  categoryId: string,
): Promise<boolean> {
  const row = await db
    .selectFrom('kb_articles')
    .select('id')
    .where('category_id', '=', categoryId)
    .where('status', '=', 'published')
    .executeTakeFirst();
  return row !== undefined;
}

export type CategoryWriteResult =
  | { status: 'ok'; category: KbCategoryRecord }
  | { status: 'invalid' }
  | { status: 'slug_taken' }
  | { status: 'not_found' };

export async function createCategory(
  db: Kysely<Database>,
  options: {
    slug: string;
    name: string;
    icon: string | null;
    displayOrder: number;
    actorId: string;
    now: Date;
  },
): Promise<CategoryWriteResult> {
  const normalized = normalizeCategory(options);
  if (normalized === undefined) return { status: 'invalid' };
  return db.transaction().execute(async (trx) => {
    if (await categorySlugTaken(trx, normalized.slug)) return { status: 'slug_taken' };
    const category = await trx
      .insertInto('kb_categories')
      .values({
        id: randomUUID(),
        slug: normalized.slug,
        name: normalized.name,
        icon: normalized.icon,
        display_order: normalized.displayOrder,
        created_at: options.now,
        updated_at: options.now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await writeAudit(
      trx,
      options.actorId,
      'support.kb.category.created',
      'kb_category',
      category.id,
    );
    return { status: 'ok', category };
  });
}

export async function updateCategory(
  db: Kysely<Database>,
  options: {
    id: string;
    slug?: string;
    name?: string;
    icon?: string | null;
    displayOrder?: number;
    actorId: string;
    now: Date;
  },
): Promise<CategoryWriteResult> {
  return db.transaction().execute(async (trx) => {
    const current = await trx
      .selectFrom('kb_categories')
      .selectAll()
      .where('id', '=', options.id)
      .forUpdate()
      .executeTakeFirst();
    if (!current) return { status: 'not_found' };
    const normalized = normalizeCategory({
      slug: options.slug ?? current.slug,
      name: options.name ?? current.name,
      icon: options.icon === undefined ? current.icon : options.icon,
      displayOrder: options.displayOrder ?? current.display_order,
    });
    if (normalized === undefined) return { status: 'invalid' };
    if (
      normalized.slug === current.slug &&
      normalized.name === current.name &&
      normalized.icon === current.icon &&
      normalized.displayOrder === current.display_order
    ) {
      return { status: 'ok', category: current };
    }
    if (await categorySlugTaken(trx, normalized.slug, current.id)) return { status: 'slug_taken' };
    const category = await trx
      .updateTable('kb_categories')
      .set({
        slug: normalized.slug,
        name: normalized.name,
        icon: normalized.icon,
        display_order: normalized.displayOrder,
        updated_at: options.now,
      })
      .where('id', '=', current.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    await writeAudit(
      trx,
      options.actorId,
      'support.kb.category.updated',
      'kb_category',
      category.id,
    );
    return { status: 'ok', category };
  });
}

export async function deleteCategory(
  db: Kysely<Database>,
  options: { id: string; actorId: string },
): Promise<{ status: 'ok' } | { status: 'not_found' } | { status: 'in_use' }> {
  return db.transaction().execute(async (trx) => {
    const current = await trx
      .selectFrom('kb_categories')
      .selectAll()
      .where('id', '=', options.id)
      .forUpdate()
      .executeTakeFirst();
    if (!current) return { status: 'not_found' };
    const article = await trx
      .selectFrom('kb_articles')
      .select('id')
      .where('category_id', '=', current.id)
      .executeTakeFirst();
    if (article) return { status: 'in_use' };
    await writeAudit(
      trx,
      options.actorId,
      'support.kb.category.deleted',
      'kb_category',
      current.id,
    );
    await trx.deleteFrom('kb_categories').where('id', '=', current.id).execute();
    return { status: 'ok' };
  });
}

export async function listArticles(
  db: Kysely<Database>,
  options: {
    publishedOnly: boolean;
    status?: KbStatus;
    categoryId?: string;
    after?: { at: string; id: string };
    limit: number;
  },
): Promise<KbArticleRecord[]> {
  let query = db.selectFrom('kb_articles').select(ARTICLE_COLUMNS);
  if (options.publishedOnly) query = query.where('status', '=', 'published');
  else if (options.status !== undefined) query = query.where('status', '=', options.status);
  if (options.categoryId !== undefined) query = query.where('category_id', '=', options.categoryId);
  const column = options.publishedOnly ? 'published_at' : 'updated_at';
  if (options.after !== undefined) {
    const at = new Date(options.after.at);
    const afterId = options.after.id;
    query = query.where((eb) =>
      eb.or([eb(column, '<', at), eb.and([eb(column, '=', at), eb('id', '<', afterId)])]),
    );
  }
  return query.orderBy(column, 'desc').orderBy('id', 'desc').limit(options.limit).execute();
}

export async function getArticle(
  db: Kysely<Database>,
  id: string,
): Promise<KbArticleRecord | undefined> {
  return db
    .selectFrom('kb_articles')
    .select(ARTICLE_COLUMNS)
    .where('id', '=', id)
    .executeTakeFirst();
}

export async function getArticleBySlug(
  db: Kysely<Database>,
  slug: string,
  publishedOnly: boolean,
): Promise<KbArticleRecord | undefined> {
  let query = db.selectFrom('kb_articles').select(ARTICLE_COLUMNS).where('slug', '=', slug);
  if (publishedOnly) query = query.where('status', '=', 'published');
  return query.executeTakeFirst();
}

export async function latestRevision(db: Kysely<Database>, articleId: string): Promise<number> {
  const row = await db
    .selectFrom('kb_revisions')
    .select((eb) => eb.fn.max<string | number | null>('revision').as('revision'))
    .where('article_id', '=', articleId)
    .executeTakeFirst();
  return Number(row?.revision ?? 0);
}

export type ArticleWriteResult =
  | { status: 'ok'; article: KbArticleRecord; revision: number }
  | { status: 'invalid' }
  | { status: 'unknown_category' }
  | { status: 'slug_taken' }
  | { status: 'not_found' };

export async function createArticle(
  db: Kysely<Database>,
  options: {
    categoryId: string;
    slug: string;
    title: string;
    body: string;
    tags: readonly string[];
    status: KbStatus;
    actorId: string;
    now: Date;
  },
): Promise<ArticleWriteResult> {
  const normalized = normalizeArticle(options);
  if (normalized === undefined) return { status: 'invalid' };
  return db.transaction().execute(async (trx) => {
    const category = await getCategory(trx, normalized.categoryId);
    if (!category) return { status: 'unknown_category' };
    if (await articleSlugTaken(trx, normalized.slug)) return { status: 'slug_taken' };
    const article = await trx
      .insertInto('kb_articles')
      .values({
        id: randomUUID(),
        category_id: normalized.categoryId,
        slug: normalized.slug,
        title: normalized.title,
        body: normalized.body,
        status: normalized.status,
        tags: normalized.tags,
        published_at: normalized.status === 'published' ? options.now : null,
        created_by: options.actorId,
        updated_by: options.actorId,
        created_at: options.now,
        updated_at: options.now,
      })
      .returning(ARTICLE_COLUMNS)
      .executeTakeFirstOrThrow();
    await writeSearchVector(trx, article.id);
    const revision = await insertRevision(trx, article, options.actorId, options.now);
    await writeAudit(trx, options.actorId, 'support.kb.article.created', 'kb_article', article.id);
    return { status: 'ok', article, revision };
  });
}

export async function updateArticle(
  db: Kysely<Database>,
  options: {
    id: string;
    categoryId?: string;
    slug?: string;
    title?: string;
    body?: string;
    tags?: readonly string[];
    status?: KbStatus;
    actorId: string;
    now: Date;
  },
): Promise<ArticleWriteResult> {
  return db.transaction().execute(async (trx) => {
    const current = await trx
      .selectFrom('kb_articles')
      .select(ARTICLE_COLUMNS)
      .where('id', '=', options.id)
      .forUpdate()
      .executeTakeFirst();
    if (!current) return { status: 'not_found' };
    const normalized = normalizeArticle({
      categoryId: options.categoryId ?? current.category_id,
      slug: options.slug ?? current.slug,
      title: options.title ?? current.title,
      body: options.body ?? current.body,
      tags: options.tags ?? current.tags,
      status: options.status ?? current.status,
    });
    if (normalized === undefined) return { status: 'invalid' };
    if (sameArticle(current, normalized)) {
      return { status: 'ok', article: current, revision: await latestRevision(trx, current.id) };
    }
    if (normalized.categoryId !== current.category_id) {
      const category = await getCategory(trx, normalized.categoryId);
      if (!category) return { status: 'unknown_category' };
    }
    if (await articleSlugTaken(trx, normalized.slug, current.id)) return { status: 'slug_taken' };
    const publishedAt =
      normalized.status === 'published'
        ? (current.published_at ?? options.now)
        : current.published_at;
    const article = await trx
      .updateTable('kb_articles')
      .set({
        category_id: normalized.categoryId,
        slug: normalized.slug,
        title: normalized.title,
        body: normalized.body,
        status: normalized.status,
        tags: normalized.tags,
        published_at: publishedAt,
        updated_by: options.actorId,
        updated_at: options.now,
      })
      .where('id', '=', current.id)
      .returning(ARTICLE_COLUMNS)
      .executeTakeFirstOrThrow();
    await writeSearchVector(trx, article.id);
    const revision = await insertRevision(trx, article, options.actorId, options.now);
    await writeAudit(trx, options.actorId, 'support.kb.article.updated', 'kb_article', article.id);
    return { status: 'ok', article, revision };
  });
}

export async function deleteArticle(
  db: Kysely<Database>,
  options: { id: string; actorId: string },
): Promise<{ status: 'ok' } | { status: 'not_found' }> {
  return db.transaction().execute(async (trx) => {
    const current = await trx
      .selectFrom('kb_articles')
      .select('id')
      .where('id', '=', options.id)
      .forUpdate()
      .executeTakeFirst();
    if (!current) return { status: 'not_found' };
    await writeAudit(trx, options.actorId, 'support.kb.article.deleted', 'kb_article', current.id);
    await trx.deleteFrom('kb_articles').where('id', '=', current.id).execute();
    return { status: 'ok' };
  });
}

export async function listRevisions(
  db: Kysely<Database>,
  articleId: string,
): Promise<KbRevisionRecord[]> {
  return db
    .selectFrom('kb_revisions')
    .selectAll()
    .where('article_id', '=', articleId)
    .orderBy('revision', 'desc')
    .execute();
}

export async function getRevision(
  db: Kysely<Database>,
  articleId: string,
  revision: number,
): Promise<KbRevisionRecord | undefined> {
  return db
    .selectFrom('kb_revisions')
    .selectAll()
    .where('article_id', '=', articleId)
    .where('revision', '=', revision)
    .executeTakeFirst();
}

export async function restoreRevision(
  db: Kysely<Database>,
  options: { articleId: string; revision: number; actorId: string; now: Date },
): Promise<ArticleWriteResult | { status: 'revision_not_found' }> {
  return db.transaction().execute(async (trx) => {
    const current = await trx
      .selectFrom('kb_articles')
      .select(ARTICLE_COLUMNS)
      .where('id', '=', options.articleId)
      .forUpdate()
      .executeTakeFirst();
    if (!current) return { status: 'not_found' };
    const revision = await getRevision(trx, current.id, options.revision);
    if (!revision) return { status: 'revision_not_found' };
    const category = await getCategory(trx, revision.category_id);
    if (!category) return { status: 'unknown_category' };
    if (await articleSlugTaken(trx, revision.slug, current.id)) return { status: 'slug_taken' };
    const publishedAt =
      revision.status === 'published'
        ? (current.published_at ?? options.now)
        : current.published_at;
    const article = await trx
      .updateTable('kb_articles')
      .set({
        category_id: revision.category_id,
        slug: revision.slug,
        title: revision.title,
        body: revision.body,
        status: revision.status,
        tags: revision.tags,
        published_at: publishedAt,
        updated_by: options.actorId,
        updated_at: options.now,
      })
      .where('id', '=', current.id)
      .returning(ARTICLE_COLUMNS)
      .executeTakeFirstOrThrow();
    await writeSearchVector(trx, article.id);
    const saved = await insertRevision(trx, article, options.actorId, options.now);
    await writeAudit(trx, options.actorId, 'support.kb.article.restored', 'kb_article', article.id);
    return { status: 'ok', article, revision: saved };
  });
}

export async function searchArticles(
  db: Kysely<Database>,
  options: { text: string; limit: number; operator: '&' | '|' },
): Promise<KbArticleRecord[]> {
  const query = tsQuery(options.text, options.operator);
  if (query === undefined) return [];
  const ranked = await sql<{ id: string }>`
    select id
    from kb_articles
    where status = 'published'
      and search_vector @@ to_tsquery('simple', ${query})
    order by ts_rank(search_vector, to_tsquery('simple', ${query})) desc, title asc, id asc
    limit ${options.limit}
  `.execute(db);
  const ids = ranked.rows.map((row) => row.id);
  if (ids.length === 0) return [];
  const articles = await db
    .selectFrom('kb_articles')
    .select(ARTICLE_COLUMNS)
    .where('id', 'in', ids)
    .execute();
  const byId = new Map(articles.map((article) => [article.id, article]));
  return ids.flatMap((id) => {
    const article = byId.get(id);
    return article === undefined ? [] : [article];
  });
}

export async function feedbackCounts(
  db: Kysely<Database>,
  articleId: string,
): Promise<{ yes: number; no: number }> {
  const rows = await db
    .selectFrom('kb_feedback')
    .select(['helpful'])
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('article_id', '=', articleId)
    .groupBy('helpful')
    .execute();
  let yes = 0;
  let no = 0;
  for (const row of rows) {
    const count = Number(row.count);
    if (row.helpful) yes = count;
    else no = count;
  }
  return { yes, no };
}

export async function recordFeedback(
  db: Kysely<Database>,
  options: { slug: string; sessionId: string; helpful: boolean; now: Date },
): Promise<{ status: 'ok'; helpful: boolean; yes: number; no: number } | { status: 'not_found' }> {
  const article = await getArticleBySlug(db, options.slug, true);
  if (!article) return { status: 'not_found' };
  await db
    .insertInto('kb_feedback')
    .values({
      article_id: article.id,
      session_id: options.sessionId,
      helpful: options.helpful,
      created_at: options.now,
      updated_at: options.now,
    })
    .onConflict((oc) =>
      oc.columns(['article_id', 'session_id']).doUpdateSet({
        helpful: options.helpful,
        updated_at: options.now,
      }),
    )
    .execute();
  const counts = await feedbackCounts(db, article.id);
  return { status: 'ok', helpful: options.helpful, ...counts };
}

export async function addImage(
  db: Kysely<Database>,
  store: ObjectStore,
  options: {
    filename: string;
    content: string;
    maxBytes: number;
    actorId: string;
    now: Date;
  },
): Promise<{ status: 'ok'; image: KbImageRecord } | { status: 'invalid' }> {
  const bytes = decodeBase64(options.content);
  if (bytes === undefined || bytes.byteLength === 0 || bytes.byteLength > options.maxBytes) {
    return { status: 'invalid' };
  }
  const sniffed = sniffAttachment(bytes);
  if (!sniffed.ok || !sniffed.image) return { status: 'invalid' };
  const id = randomUUID();
  const key = kbImageObjectKey(id);
  await store.put(key, bytes, sniffed.contentType);
  try {
    const image = await db.transaction().execute(async (trx) => {
      const row = await trx
        .insertInto('kb_images')
        .values({
          id,
          object_key: key,
          filename: options.filename,
          content_type: sniffed.contentType,
          size_bytes: bytes.byteLength,
          created_by: options.actorId,
          created_at: options.now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await writeAudit(trx, options.actorId, 'support.kb.image.created', 'kb_image', row.id);
      return row;
    });
    return { status: 'ok', image };
  } catch (error) {
    await store.delete(key);
    throw error;
  }
}

export async function getImage(
  db: Kysely<Database>,
  id: string,
): Promise<KbImageRecord | undefined> {
  return db.selectFrom('kb_images').selectAll().where('id', '=', id).executeTakeFirst();
}
