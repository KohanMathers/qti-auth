import {
  decodeCursor,
  pageOf,
  pageSchema,
  paginationQuery,
  ProblemError,
  type Router,
} from '@qtiauth/service-kit';
import * as z from 'zod';

import { KB_STATUSES } from './database.ts';
import { revisionDocument, unifiedDiff } from './diff.ts';
import {
  addImage,
  createArticle,
  createCategory,
  deleteArticle,
  deleteCategory,
  getArticle,
  getRevision,
  KB_ORDER_MAX,
  kbImagePath,
  type KbArticleRecord,
  type KbCategoryRecord,
  type KbRevisionRecord,
  latestRevision,
  listArticles,
  listCategories,
  listRevisions,
  restoreRevision,
  updateArticle,
  updateCategory,
} from './kb.ts';
import { ensureKb, kbImageStore } from './kb-routes.ts';
import { renderMarkdown } from './markdown.ts';
import { signedIn } from './routes.ts';
import type { Context } from './service.ts';

const updatedPosition = z.object({ updated_at: z.iso.datetime(), id: z.uuid() });

const categorySchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  icon: z.string().nullable(),
  display_order: z.int(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});

const articleSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  title: z.string(),
  body: z.string(),
  html: z.string(),
  status: z.enum(KB_STATUSES),
  category_id: z.uuid(),
  tags: z.array(z.string()),
  published_at: z.iso.datetime().nullable(),
  revision: z.int(),
  created_by: z.uuid(),
  updated_by: z.uuid(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});

const revisionSchema = z.object({
  revision: z.int(),
  title: z.string(),
  slug: z.string(),
  body: z.string(),
  tags: z.array(z.string()),
  category_id: z.uuid(),
  status: z.enum(KB_STATUSES),
  author_id: z.uuid(),
  created_at: z.iso.datetime(),
});

const categoryBody = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  icon: z.string().nullable().optional(),
  display_order: z.int().min(0).max(KB_ORDER_MAX).optional(),
});

const categoryPatch = z.object({
  slug: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  icon: z.string().nullable().optional(),
  display_order: z.int().min(0).max(KB_ORDER_MAX).optional(),
});

const articleBody = z.object({
  category_id: z.uuid(),
  slug: z.string().min(1),
  title: z.string().min(1),
  body: z.string(),
  tags: z.array(z.string()).optional(),
  status: z.enum(KB_STATUSES).optional(),
});

const articlePatch = z.object({
  category_id: z.uuid().optional(),
  slug: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  body: z.string().optional(),
  tags: z.array(z.string()).optional(),
  status: z.enum(KB_STATUSES).optional(),
});

const imageBody = z.object({
  filename: z.string().min(1).max(200),
  content: z
    .string()
    .min(1)
    .max(70_000_000)
    .describe('Base64-encoded image. The type is sniffed from the bytes, not the filename.'),
});

const imageSchema = z.object({
  id: z.uuid(),
  filename: z.string(),
  content_type: z.string(),
  size_bytes: z.int(),
  path: z.string(),
  created_at: z.iso.datetime(),
});

const listQuery = paginationQuery({ defaultLimit: 25, maxLimit: 100 }).extend({
  status: z.enum(KB_STATUSES).optional(),
  category_id: z.uuid().optional(),
});

function presentedCategory(category: KbCategoryRecord) {
  return {
    id: category.id,
    slug: category.slug,
    name: category.name,
    icon: category.icon,
    display_order: category.display_order,
    created_at: category.created_at.toISOString(),
    updated_at: category.updated_at.toISOString(),
  };
}

function presentedArticle(article: KbArticleRecord, revision: number) {
  return {
    id: article.id,
    slug: article.slug,
    title: article.title,
    body: article.body,
    html: renderMarkdown(article.body),
    status: article.status,
    category_id: article.category_id,
    tags: article.tags,
    published_at: article.published_at?.toISOString() ?? null,
    revision,
    created_by: article.created_by,
    updated_by: article.updated_by,
    created_at: article.created_at.toISOString(),
    updated_at: article.updated_at.toISOString(),
  };
}

function presentedRevision(revision: KbRevisionRecord) {
  return {
    revision: revision.revision,
    title: revision.title,
    slug: revision.slug,
    body: revision.body,
    tags: revision.tags,
    category_id: revision.category_id,
    status: revision.status,
    author_id: revision.author_id,
    created_at: revision.created_at.toISOString(),
  };
}

function categoryFailure(status: 'invalid' | 'slug_taken' | 'not_found' | 'in_use'): never {
  if (status === 'invalid') throw new ProblemError('SUPPORT_KB_INVALID');
  if (status === 'slug_taken') throw new ProblemError('SUPPORT_KB_SLUG_TAKEN');
  if (status === 'in_use') throw new ProblemError('SUPPORT_KB_CATEGORY_IN_USE');
  throw new ProblemError('SUPPORT_KB_CATEGORY_NOT_FOUND');
}

function articleFailure(
  status: 'invalid' | 'unknown_category' | 'slug_taken' | 'not_found' | 'revision_not_found',
): never {
  if (status === 'invalid') throw new ProblemError('SUPPORT_KB_INVALID');
  if (status === 'unknown_category') throw new ProblemError('SUPPORT_KB_CATEGORY_NOT_FOUND');
  if (status === 'slug_taken') throw new ProblemError('SUPPORT_KB_SLUG_TAKEN');
  if (status === 'revision_not_found') throw new ProblemError('SUPPORT_KB_REVISION_NOT_FOUND');
  throw new ProblemError('SUPPORT_KB_ARTICLE_NOT_FOUND');
}

const WRITE_ERRORS = [
  'SUPPORT_KB_DISABLED',
  'SUPPORT_KB_INVALID',
  'SUPPORT_KB_CATEGORY_NOT_FOUND',
  'SUPPORT_KB_SLUG_TAKEN',
] as const;

export function kbStaffRoutes(router: Router<Context>): void {
  router.route({
    method: 'GET',
    path: '/api/v1/admin/support/kb/categories',
    operation_id: 'listStaffKbCategories',
    summary: 'Knowledge-base categories',
    tags: ['support'],
    auth: 'session',
    permissions: ['support.kb.edit'],
    rate_limit: 'global',
    responses: {
      200: { description: 'Every category', schema: z.object({ items: z.array(categorySchema) }) },
    },
    errors: ['SUPPORT_KB_DISABLED'],
    handler: async ({ ctx }) => {
      ensureKb(ctx.config.features.support.kb.enabled);
      const items = await listCategories(ctx.db);
      return { status: 200 as const, body: { items: items.map(presentedCategory) } };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/admin/support/kb/categories',
    operation_id: 'createKbCategory',
    summary: 'Create a knowledge-base category',
    tags: ['support'],
    auth: 'session',
    permissions: ['support.kb.edit'],
    rate_limit: 'global',
    request: { body: categoryBody },
    responses: { 201: { description: 'The category', schema: categorySchema } },
    errors: ['SUPPORT_KB_DISABLED', 'SUPPORT_KB_INVALID', 'SUPPORT_KB_SLUG_TAKEN'],
    handler: async ({ ctx, identity, body }) => {
      ensureKb(ctx.config.features.support.kb.enabled);
      const result = await createCategory(ctx.db, {
        slug: body.slug,
        name: body.name,
        icon: body.icon ?? null,
        displayOrder: body.display_order ?? 0,
        actorId: signedIn(identity),
        now: new Date(),
      });
      if (result.status !== 'ok') categoryFailure(result.status);
      ctx.outbox.wake();
      return { status: 201 as const, body: presentedCategory(result.category) };
    },
  });

  router.route({
    method: 'PATCH',
    path: '/api/v1/admin/support/kb/categories/:category_id',
    operation_id: 'updateKbCategory',
    summary: 'Edit a knowledge-base category',
    tags: ['support'],
    auth: 'session',
    permissions: ['support.kb.edit'],
    rate_limit: 'global',
    request: {
      params: z.object({ category_id: z.uuid() }),
      body: categoryPatch,
    },
    responses: { 200: { description: 'The category', schema: categorySchema } },
    errors: [
      'SUPPORT_KB_DISABLED',
      'SUPPORT_KB_INVALID',
      'SUPPORT_KB_SLUG_TAKEN',
      'SUPPORT_KB_CATEGORY_NOT_FOUND',
    ],
    handler: async ({ ctx, identity, params, body }) => {
      ensureKb(ctx.config.features.support.kb.enabled);
      const result = await updateCategory(ctx.db, {
        id: params.category_id,
        actorId: signedIn(identity),
        now: new Date(),
        ...(body.slug === undefined ? {} : { slug: body.slug }),
        ...(body.name === undefined ? {} : { name: body.name }),
        ...(body.icon === undefined ? {} : { icon: body.icon }),
        ...(body.display_order === undefined ? {} : { displayOrder: body.display_order }),
      });
      if (result.status !== 'ok') categoryFailure(result.status);
      ctx.outbox.wake();
      return { status: 200 as const, body: presentedCategory(result.category) };
    },
  });

  router.route({
    method: 'DELETE',
    path: '/api/v1/admin/support/kb/categories/:category_id',
    operation_id: 'deleteKbCategory',
    summary: 'Delete a knowledge-base category',
    tags: ['support'],
    auth: 'session',
    permissions: ['support.kb.edit'],
    rate_limit: 'global',
    request: { params: z.object({ category_id: z.uuid() }) },
    responses: { 204: { description: 'Deleted' } },
    errors: ['SUPPORT_KB_DISABLED', 'SUPPORT_KB_CATEGORY_NOT_FOUND', 'SUPPORT_KB_CATEGORY_IN_USE'],
    handler: async ({ ctx, identity, params }) => {
      ensureKb(ctx.config.features.support.kb.enabled);
      const result = await deleteCategory(ctx.db, {
        id: params.category_id,
        actorId: signedIn(identity),
      });
      if (result.status !== 'ok') categoryFailure(result.status);
      ctx.outbox.wake();
      return { status: 204 as const };
    },
  });

  router.route({
    method: 'GET',
    path: '/api/v1/admin/support/kb/articles',
    operation_id: 'listStaffKbArticles',
    summary: 'Knowledge-base articles, including drafts',
    tags: ['support'],
    auth: 'session',
    permissions: ['support.kb.edit'],
    rate_limit: 'global',
    request: { query: listQuery },
    responses: { 200: { description: 'Articles', schema: pageSchema(articleSchema) } },
    errors: ['SUPPORT_KB_DISABLED'],
    handler: async ({ ctx, query }) => {
      ensureKb(ctx.config.features.support.kb.enabled);
      const after = decodeCursor(updatedPosition, query.cursor);
      const rows = await listArticles(ctx.db, {
        publishedOnly: false,
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.category_id === undefined ? {} : { categoryId: query.category_id }),
        ...(after === undefined ? {} : { after: { at: after.updated_at, id: after.id } }),
        limit: query.limit + 1,
      });
      const page = pageOf(rows, query.limit, (article) => ({
        updated_at: article.updated_at.toISOString(),
        id: article.id,
      }));
      const items = await Promise.all(
        page.items.map(async (article) =>
          presentedArticle(article, await latestRevision(ctx.db, article.id)),
        ),
      );
      return { status: 200 as const, body: { items, next_cursor: page.next_cursor } };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/admin/support/kb/articles',
    operation_id: 'createKbArticle',
    summary: 'Create a knowledge-base article',
    tags: ['support'],
    auth: 'session',
    permissions: ['support.kb.edit'],
    rate_limit: 'global',
    request: { body: articleBody },
    responses: { 201: { description: 'The article', schema: articleSchema } },
    errors: WRITE_ERRORS,
    handler: async ({ ctx, identity, body }) => {
      ensureKb(ctx.config.features.support.kb.enabled);
      const result = await createArticle(ctx.db, {
        categoryId: body.category_id,
        slug: body.slug,
        title: body.title,
        body: body.body,
        tags: body.tags ?? [],
        status: body.status ?? 'draft',
        actorId: signedIn(identity),
        now: new Date(),
      });
      if (result.status !== 'ok') articleFailure(result.status);
      ctx.outbox.wake();
      return { status: 201 as const, body: presentedArticle(result.article, result.revision) };
    },
  });

  router.route({
    method: 'GET',
    path: '/api/v1/admin/support/kb/articles/:article_id',
    operation_id: 'getStaffKbArticle',
    summary: 'A knowledge-base article, including drafts',
    tags: ['support'],
    auth: 'session',
    permissions: ['support.kb.edit'],
    rate_limit: 'global',
    request: { params: z.object({ article_id: z.uuid() }) },
    responses: { 200: { description: 'The article', schema: articleSchema } },
    errors: ['SUPPORT_KB_DISABLED', 'SUPPORT_KB_ARTICLE_NOT_FOUND'],
    handler: async ({ ctx, params }) => {
      ensureKb(ctx.config.features.support.kb.enabled);
      const article = await getArticle(ctx.db, params.article_id);
      if (!article) throw new ProblemError('SUPPORT_KB_ARTICLE_NOT_FOUND');
      return {
        status: 200 as const,
        body: presentedArticle(article, await latestRevision(ctx.db, article.id)),
      };
    },
  });

  router.route({
    method: 'PATCH',
    path: '/api/v1/admin/support/kb/articles/:article_id',
    operation_id: 'updateKbArticle',
    summary: 'Edit a knowledge-base article',
    tags: ['support'],
    auth: 'session',
    permissions: ['support.kb.edit'],
    rate_limit: 'global',
    request: { params: z.object({ article_id: z.uuid() }), body: articlePatch },
    responses: { 200: { description: 'The article', schema: articleSchema } },
    errors: WRITE_ERRORS,
    handler: async ({ ctx, identity, params, body }) => {
      ensureKb(ctx.config.features.support.kb.enabled);
      const result = await updateArticle(ctx.db, {
        id: params.article_id,
        actorId: signedIn(identity),
        now: new Date(),
        ...(body.category_id === undefined ? {} : { categoryId: body.category_id }),
        ...(body.slug === undefined ? {} : { slug: body.slug }),
        ...(body.title === undefined ? {} : { title: body.title }),
        ...(body.body === undefined ? {} : { body: body.body }),
        ...(body.tags === undefined ? {} : { tags: body.tags }),
        ...(body.status === undefined ? {} : { status: body.status }),
      });
      if (result.status !== 'ok') articleFailure(result.status);
      ctx.outbox.wake();
      return { status: 200 as const, body: presentedArticle(result.article, result.revision) };
    },
  });

  router.route({
    method: 'DELETE',
    path: '/api/v1/admin/support/kb/articles/:article_id',
    operation_id: 'deleteKbArticle',
    summary: 'Delete a knowledge-base article',
    tags: ['support'],
    auth: 'session',
    permissions: ['support.kb.edit'],
    rate_limit: 'global',
    request: { params: z.object({ article_id: z.uuid() }) },
    responses: { 204: { description: 'Deleted' } },
    errors: ['SUPPORT_KB_DISABLED', 'SUPPORT_KB_ARTICLE_NOT_FOUND'],
    handler: async ({ ctx, identity, params }) => {
      ensureKb(ctx.config.features.support.kb.enabled);
      const result = await deleteArticle(ctx.db, {
        id: params.article_id,
        actorId: signedIn(identity),
      });
      if (result.status !== 'ok') articleFailure(result.status);
      ctx.outbox.wake();
      return { status: 204 as const };
    },
  });

  router.route({
    method: 'GET',
    path: '/api/v1/admin/support/kb/articles/:article_id/revisions',
    operation_id: 'listKbRevisions',
    summary: 'Revision history for an article',
    tags: ['support'],
    auth: 'session',
    permissions: ['support.kb.edit'],
    rate_limit: 'global',
    request: { params: z.object({ article_id: z.uuid() }) },
    responses: {
      200: {
        description: 'Revisions, newest first',
        schema: z.object({ items: z.array(revisionSchema) }),
      },
    },
    errors: ['SUPPORT_KB_DISABLED', 'SUPPORT_KB_ARTICLE_NOT_FOUND'],
    handler: async ({ ctx, params }) => {
      ensureKb(ctx.config.features.support.kb.enabled);
      const article = await getArticle(ctx.db, params.article_id);
      if (!article) throw new ProblemError('SUPPORT_KB_ARTICLE_NOT_FOUND');
      const items = await listRevisions(ctx.db, article.id);
      return { status: 200 as const, body: { items: items.map(presentedRevision) } };
    },
  });

  router.route({
    method: 'GET',
    path: '/api/v1/admin/support/kb/articles/:article_id/revisions/:revision',
    operation_id: 'getKbRevision',
    summary: 'One revision of an article',
    tags: ['support'],
    auth: 'session',
    permissions: ['support.kb.edit'],
    rate_limit: 'global',
    request: {
      params: z.object({
        article_id: z.uuid(),
        revision: z.coerce.number().int().positive(),
      }),
    },
    responses: { 200: { description: 'The revision', schema: revisionSchema } },
    errors: [
      'SUPPORT_KB_DISABLED',
      'SUPPORT_KB_ARTICLE_NOT_FOUND',
      'SUPPORT_KB_REVISION_NOT_FOUND',
    ],
    handler: async ({ ctx, params }) => {
      ensureKb(ctx.config.features.support.kb.enabled);
      const article = await getArticle(ctx.db, params.article_id);
      if (!article) throw new ProblemError('SUPPORT_KB_ARTICLE_NOT_FOUND');
      const revision = await getRevision(ctx.db, article.id, params.revision);
      if (!revision) throw new ProblemError('SUPPORT_KB_REVISION_NOT_FOUND');
      return { status: 200 as const, body: presentedRevision(revision) };
    },
  });

  router.route({
    method: 'GET',
    path: '/api/v1/admin/support/kb/articles/:article_id/revisions/:revision/diff',
    operation_id: 'diffKbRevision',
    summary: 'Diff a revision against an earlier one',
    description:
      'against defaults to the previous revision. against=0 diffs the first revision against an empty article.',
    tags: ['support'],
    auth: 'session',
    permissions: ['support.kb.edit'],
    rate_limit: 'global',
    request: {
      params: z.object({
        article_id: z.uuid(),
        revision: z.coerce.number().int().positive(),
      }),
      query: z.object({ against: z.coerce.number().int().min(0).optional() }),
    },
    responses: {
      200: {
        description: 'A line diff of the revision documents',
        schema: z.object({ revision: z.int(), against: z.int(), diff: z.string() }),
      },
    },
    errors: [
      'SUPPORT_KB_DISABLED',
      'SUPPORT_KB_ARTICLE_NOT_FOUND',
      'SUPPORT_KB_REVISION_NOT_FOUND',
    ],
    handler: async ({ ctx, params, query }) => {
      ensureKb(ctx.config.features.support.kb.enabled);
      const article = await getArticle(ctx.db, params.article_id);
      if (!article) throw new ProblemError('SUPPORT_KB_ARTICLE_NOT_FOUND');
      const revision = await getRevision(ctx.db, article.id, params.revision);
      if (!revision) throw new ProblemError('SUPPORT_KB_REVISION_NOT_FOUND');
      const against = query.against ?? Math.max(0, revision.revision - 1);
      const previous = against === 0 ? undefined : await getRevision(ctx.db, article.id, against);
      if (against !== 0 && previous === undefined) {
        throw new ProblemError('SUPPORT_KB_REVISION_NOT_FOUND');
      }
      const before = previous === undefined ? '' : revisionDocument(previous);
      return {
        status: 200 as const,
        body: {
          revision: revision.revision,
          against,
          diff: unifiedDiff(before, revisionDocument(revision)),
        },
      };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/admin/support/kb/articles/:article_id/revisions/:revision/restore',
    operation_id: 'restoreKbRevision',
    summary: 'Restore an earlier revision',
    description: 'Copies that revision onto the article and records it as a new revision.',
    tags: ['support'],
    auth: 'session',
    permissions: ['support.kb.edit'],
    rate_limit: 'global',
    request: {
      params: z.object({
        article_id: z.uuid(),
        revision: z.coerce.number().int().positive(),
      }),
    },
    responses: { 200: { description: 'The restored article', schema: articleSchema } },
    errors: [
      'SUPPORT_KB_DISABLED',
      'SUPPORT_KB_ARTICLE_NOT_FOUND',
      'SUPPORT_KB_REVISION_NOT_FOUND',
      'SUPPORT_KB_CATEGORY_NOT_FOUND',
      'SUPPORT_KB_SLUG_TAKEN',
    ],
    handler: async ({ ctx, identity, params }) => {
      ensureKb(ctx.config.features.support.kb.enabled);
      const result = await restoreRevision(ctx.db, {
        articleId: params.article_id,
        revision: params.revision,
        actorId: signedIn(identity),
        now: new Date(),
      });
      if (result.status !== 'ok') articleFailure(result.status);
      ctx.outbox.wake();
      return { status: 200 as const, body: presentedArticle(result.article, result.revision) };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/admin/support/kb/images',
    operation_id: 'uploadKbImage',
    summary: 'Upload a knowledge-base image',
    description:
      'JPEG, PNG, GIF and WebP only. The type is sniffed from the bytes. Needs an object store. Reference the image as /api/v1/support/kb/images/{id}.',
    tags: ['support'],
    auth: 'session',
    permissions: ['support.kb.edit'],
    rate_limit: 'global',
    request: { body: imageBody },
    responses: { 201: { description: 'The image', schema: imageSchema } },
    errors: ['SUPPORT_KB_DISABLED', 'SUPPORT_STORAGE_UNAVAILABLE', 'SUPPORT_KB_IMAGE_INVALID'],
    handler: async ({ ctx, identity, body }) => {
      const store = kbImageStore(ctx);
      const result = await addImage(ctx.db, store, {
        filename: body.filename,
        content: body.content,
        maxBytes: ctx.config.support.attachment_max_bytes,
        actorId: signedIn(identity),
        now: new Date(),
      });
      if (result.status === 'invalid') throw new ProblemError('SUPPORT_KB_IMAGE_INVALID');
      ctx.outbox.wake();
      return {
        status: 201 as const,
        body: {
          id: result.image.id,
          filename: result.image.filename,
          content_type: result.image.content_type,
          size_bytes: result.image.size_bytes,
          path: kbImagePath(result.image.id),
          created_at: result.image.created_at.toISOString(),
        },
      };
    },
  });
}
