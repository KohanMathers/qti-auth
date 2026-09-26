import {
  decodeCursor,
  pageOf,
  pageSchema,
  paginationQuery,
  ProblemError,
  type Router,
} from '@qtiauth/service-kit';
import * as z from 'zod';

import {
  feedbackCounts,
  getArticleBySlug,
  getCategory,
  getCategoryBySlug,
  getImage,
  hasPublishedArticle,
  KB_RELATED_LIMIT,
  KB_SEARCH_LIMIT,
  KB_SLUG_MAX,
  KB_TITLE_MAX,
  type KbArticleRecord,
  type KbCategoryRecord,
  listArticles,
  listPublicCategories,
  recordFeedback,
  searchArticles,
} from './kb.ts';
import { renderMarkdown } from './markdown.ts';
import { supportMetrics } from './metrics.ts';
import type { Context } from './service.ts';
import { safeFilename } from './sniff.ts';
import { objectStoreOf } from './storage-state.ts';

const publishedPosition = z.object({ published_at: z.iso.datetime(), id: z.uuid() });

const categorySchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  icon: z.string().nullable(),
  display_order: z.int(),
});

const articleSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  title: z.string(),
  category_id: z.uuid(),
  tags: z.array(z.string()),
  published_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});

const articleDetailSchema = articleSchema.extend({
  html: z.string(),
  category: categorySchema,
  feedback: z.object({ yes: z.int(), no: z.int() }),
});

const listQuery = paginationQuery({ defaultLimit: 25, maxLimit: 100 }).extend({
  category: z.string().min(1).max(KB_SLUG_MAX).optional(),
});

export function ensureKb(enabled: boolean): void {
  if (!enabled) throw new ProblemError('SUPPORT_KB_DISABLED');
}

export function kbImageStore(ctx: Context) {
  ensureKb(ctx.config.features.support.kb.enabled);
  const store = objectStoreOf(ctx);
  if (store == null) throw new ProblemError('SUPPORT_STORAGE_UNAVAILABLE');
  return store;
}

function presentedCategory(category: KbCategoryRecord) {
  return {
    id: category.id,
    slug: category.slug,
    name: category.name,
    icon: category.icon,
    display_order: category.display_order,
  };
}

function presentedArticle(article: KbArticleRecord) {
  return {
    id: article.id,
    slug: article.slug,
    title: article.title,
    category_id: article.category_id,
    tags: article.tags,
    published_at: (article.published_at ?? article.updated_at).toISOString(),
    updated_at: article.updated_at.toISOString(),
  };
}

export function kbRoutes(router: Router<Context>): void {
  router.route({
    method: 'GET',
    path: '/api/v1/support/kb/categories',
    operation_id: 'listKbCategories',
    summary: 'Published knowledge-base categories',
    tags: ['support'],
    auth: 'none',
    rate_limit: 'global',
    responses: {
      200: {
        description: 'Categories that have a published article',
        schema: z.object({ items: z.array(categorySchema) }),
      },
    },
    errors: ['SUPPORT_KB_DISABLED'],
    handler: async ({ ctx }) => {
      ensureKb(ctx.config.features.support.kb.enabled);
      const items = await listPublicCategories(ctx.db);
      return { status: 200 as const, body: { items: items.map(presentedCategory) } };
    },
  });

  router.route({
    method: 'GET',
    path: '/api/v1/support/kb/categories/:slug',
    operation_id: 'getKbCategory',
    summary: 'A knowledge-base category and its published articles',
    tags: ['support'],
    auth: 'none',
    rate_limit: 'global',
    request: {
      params: z.object({ slug: z.string().min(1).max(KB_SLUG_MAX) }),
      query: paginationQuery({ defaultLimit: 25, maxLimit: 100 }),
    },
    responses: {
      200: {
        description: 'The category and a page of its published articles',
        schema: categorySchema.extend({ articles: pageSchema(articleSchema) }),
      },
    },
    errors: ['SUPPORT_KB_DISABLED', 'SUPPORT_KB_CATEGORY_NOT_FOUND'],
    handler: async ({ ctx, params, query }) => {
      ensureKb(ctx.config.features.support.kb.enabled);
      const category = await getCategoryBySlug(ctx.db, params.slug);
      if (!category || !(await hasPublishedArticle(ctx.db, category.id))) {
        throw new ProblemError('SUPPORT_KB_CATEGORY_NOT_FOUND');
      }
      const after = decodeCursor(publishedPosition, query.cursor);
      const rows = await listArticles(ctx.db, {
        publishedOnly: true,
        categoryId: category.id,
        ...(after === undefined ? {} : { after: { at: after.published_at, id: after.id } }),
        limit: query.limit + 1,
      });
      const page = pageOf(rows, query.limit, (article) => ({
        published_at: (article.published_at ?? article.updated_at).toISOString(),
        id: article.id,
      }));
      return {
        status: 200 as const,
        body: {
          ...presentedCategory(category),
          articles: {
            items: page.items.map(presentedArticle),
            next_cursor: page.next_cursor,
          },
        },
      };
    },
  });

  router.route({
    method: 'GET',
    path: '/api/v1/support/kb/articles',
    operation_id: 'listKbArticles',
    summary: 'Published knowledge-base articles',
    tags: ['support'],
    auth: 'none',
    rate_limit: 'global',
    request: { query: listQuery },
    responses: {
      200: { description: 'Published articles', schema: pageSchema(articleSchema) },
    },
    errors: ['SUPPORT_KB_DISABLED', 'SUPPORT_KB_CATEGORY_NOT_FOUND'],
    handler: async ({ ctx, query }) => {
      ensureKb(ctx.config.features.support.kb.enabled);
      let categoryId: string | undefined;
      if (query.category !== undefined) {
        const category = await getCategoryBySlug(ctx.db, query.category);
        if (!category) throw new ProblemError('SUPPORT_KB_CATEGORY_NOT_FOUND');
        categoryId = category.id;
      }
      const after = decodeCursor(publishedPosition, query.cursor);
      const rows = await listArticles(ctx.db, {
        publishedOnly: true,
        ...(categoryId === undefined ? {} : { categoryId }),
        ...(after === undefined ? {} : { after: { at: after.published_at, id: after.id } }),
        limit: query.limit + 1,
      });
      const page = pageOf(rows, query.limit, (article) => ({
        published_at: (article.published_at ?? article.updated_at).toISOString(),
        id: article.id,
      }));
      return {
        status: 200 as const,
        body: { items: page.items.map(presentedArticle), next_cursor: page.next_cursor },
      };
    },
  });

  router.route({
    method: 'GET',
    path: '/api/v1/support/kb/articles/:slug',
    operation_id: 'getKbArticle',
    summary: 'A published knowledge-base article',
    tags: ['support'],
    auth: 'none',
    rate_limit: 'global',
    request: { params: z.object({ slug: z.string().min(1).max(KB_SLUG_MAX) }) },
    responses: { 200: { description: 'The article, rendered', schema: articleDetailSchema } },
    errors: ['SUPPORT_KB_DISABLED', 'SUPPORT_KB_ARTICLE_NOT_FOUND'],
    handler: async ({ ctx, params }) => {
      ensureKb(ctx.config.features.support.kb.enabled);
      const article = await getArticleBySlug(ctx.db, params.slug, true);
      if (!article) throw new ProblemError('SUPPORT_KB_ARTICLE_NOT_FOUND');
      const category = await getCategory(ctx.db, article.category_id);
      if (!category) throw new ProblemError('SUPPORT_KB_ARTICLE_NOT_FOUND');
      supportMetrics(ctx.metrics).view();
      const feedback = await feedbackCounts(ctx.db, article.id);
      return {
        status: 200 as const,
        body: {
          ...presentedArticle(article),
          html: renderMarkdown(article.body),
          category: presentedCategory(category),
          feedback,
        },
      };
    },
  });

  router.route({
    method: 'GET',
    path: '/api/v1/support/kb/search',
    operation_id: 'searchKbArticles',
    summary: 'Search published articles',
    description: 'Postgres full-text search, weighted title, then tags, then body.',
    tags: ['support'],
    auth: 'none',
    rate_limit: 'global',
    request: { query: z.object({ q: z.string().min(1).max(KB_TITLE_MAX) }) },
    responses: {
      200: {
        description: 'Matching published articles',
        schema: z.object({ items: z.array(articleSchema) }),
      },
    },
    errors: ['SUPPORT_KB_DISABLED'],
    handler: async ({ ctx, query }) => {
      ensureKb(ctx.config.features.support.kb.enabled);
      const items = await searchArticles(ctx.db, {
        text: query.q,
        limit: KB_SEARCH_LIMIT,
        operator: '&',
      });
      return { status: 200 as const, body: { items: items.map(presentedArticle) } };
    },
  });

  router.route({
    method: 'GET',
    path: '/api/v1/support/kb/related',
    operation_id: 'relatedKbArticles',
    summary: 'Articles related to a ticket subject',
    description:
      'Suggested while a ticket subject is being typed. Matches any word, still weighted title, then tags, then body.',
    tags: ['support'],
    auth: 'none',
    rate_limit: 'global',
    request: { query: z.object({ subject: z.string().max(KB_TITLE_MAX).default('') }) },
    responses: {
      200: {
        description: 'Suggested articles',
        schema: z.object({ items: z.array(articleSchema) }),
      },
    },
    errors: ['SUPPORT_KB_DISABLED'],
    handler: async ({ ctx, query }) => {
      ensureKb(ctx.config.features.support.kb.enabled);
      const items = await searchArticles(ctx.db, {
        text: query.subject,
        limit: KB_RELATED_LIMIT,
        operator: '|',
      });
      return { status: 200 as const, body: { items: items.map(presentedArticle) } };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/support/kb/articles/:slug/feedback',
    operation_id: 'kbArticleFeedback',
    summary: 'Say whether an article helped',
    description:
      'Limited per IP by the kb_feedback policy. A later vote from the same session replaces the earlier one.',
    tags: ['support'],
    auth: 'none',
    rate_limit: 'kb_feedback',
    request: {
      params: z.object({ slug: z.string().min(1).max(KB_SLUG_MAX) }),
      body: z.object({ helpful: z.boolean() }),
    },
    responses: {
      200: {
        description: 'The stored vote and the article totals',
        schema: z.object({ helpful: z.boolean(), yes: z.int(), no: z.int() }),
      },
    },
    errors: ['SUPPORT_KB_DISABLED', 'SUPPORT_KB_ARTICLE_NOT_FOUND', 'SUPPORT_KB_SESSION_REQUIRED'],
    handler: async ({ ctx, identity, params, body }) => {
      ensureKb(ctx.config.features.support.kb.enabled);
      if (identity.sid === null) throw new ProblemError('SUPPORT_KB_SESSION_REQUIRED');
      const result = await recordFeedback(ctx.db, {
        slug: params.slug,
        sessionId: identity.sid,
        helpful: body.helpful,
        now: new Date(),
      });
      if (result.status === 'not_found') throw new ProblemError('SUPPORT_KB_ARTICLE_NOT_FOUND');
      supportMetrics(ctx.metrics).feedback(body.helpful);
      return {
        status: 200 as const,
        body: { helpful: result.helpful, yes: result.yes, no: result.no },
      };
    },
  });

  router.route({
    method: 'GET',
    path: '/api/v1/support/kb/images/:image_id',
    operation_id: 'getKbImage',
    summary: 'A knowledge-base image',
    tags: ['support'],
    auth: 'none',
    rate_limit: 'global',
    request: { params: z.object({ image_id: z.uuid() }) },
    responses: {
      200: { description: 'The image bytes, with the sniffed content type', schema: z.string() },
    },
    errors: ['SUPPORT_KB_DISABLED', 'SUPPORT_STORAGE_UNAVAILABLE', 'SUPPORT_KB_IMAGE_NOT_FOUND'],
    handler: async ({ ctx, params }) => {
      const store = kbImageStore(ctx);
      const image = await getImage(ctx.db, params.image_id);
      if (!image) throw new ProblemError('SUPPORT_KB_IMAGE_NOT_FOUND');
      const bytes = await store.get(image.object_key);
      if (bytes === undefined) throw new ProblemError('SUPPORT_KB_IMAGE_NOT_FOUND');
      return new Response(bytes, {
        status: 200,
        headers: {
          'content-type': image.content_type,
          'x-content-type-options': 'nosniff',
          'content-disposition': `inline; filename="${safeFilename(image.filename)}"`,
          'cache-control': 'private, max-age=300',
        },
      });
    },
  });
}
