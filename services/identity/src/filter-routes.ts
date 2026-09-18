import type { EventActor } from '@qtiauth/events';
import {
  decodeCursor,
  pageOf,
  pageSchema,
  paginationQuery,
  ProblemError,
  type Router,
} from '@qtiauth/service-kit';
import { normalize } from '@qtiauth/text-filter';
import * as z from 'zod';

import { addListEntry, listFilterDecisions, removeListEntry, requireTextFilter } from './filter.ts';
import { NO_STORE } from './headers.ts';
import type { Context } from './service.ts';
import { signedIn } from './session-routes.ts';

const position = z.object({ created_at: z.iso.datetime(), id: z.uuid() });
const wordBody = z.object({
  word: z
    .string()
    .min(1)
    .max(200)
    .describe('Word to add. The same normalization as the filter is applied.'),
});
const wordParam = z.object({ word: z.string().min(1).max(200) });

const decisionSchema = z.object({
  id: z.uuid(),
  input_hash: z.string(),
  raw_input: z.string().nullable(),
  normalized: z.string(),
  decision: z.enum(['allow', 'block']),
  rule: z.string(),
  matched_entry: z.string().nullable(),
  context: z.string(),
  created_at: z.iso.datetime(),
});

const listEntrySchema = z.object({
  word: z.string(),
  source: z.enum(['file', 'admin']),
});

function normalizedWord(raw: string): string {
  const word = normalize(raw);
  if (word === '') throw new ProblemError('FILTER_ENTRY_NOT_FOUND');
  return word;
}

function listedWords(
  file: ReadonlySet<string>,
  live: ReadonlySet<string>,
): { word: string; source: 'file' | 'admin' }[] {
  const items = new Map<string, 'file' | 'admin'>();
  for (const word of file) items.set(word, 'file');
  for (const word of live) {
    if (!items.has(word)) items.set(word, 'admin');
  }
  return [...items.entries()]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([word, source]) => ({ word, source }));
}

function staffActor(identity: Parameters<typeof signedIn>[0]): EventActor {
  return { type: 'user', id: signedIn(identity).userId };
}

function decisionPage(rows: Awaited<ReturnType<typeof listFilterDecisions>>, limit: number) {
  const page = pageOf(rows, limit, (row) => ({
    created_at: row.created_at.toISOString(),
    id: row.id,
  }));
  return {
    status: 200 as const,
    headers: NO_STORE,
    body: {
      next_cursor: page.next_cursor,
      items: page.items.map((row) => ({
        ...row,
        created_at: row.created_at.toISOString(),
      })),
    },
  };
}

export function filterRoutes(router: Router<Context>): void {
  router.route({
    method: 'GET',
    path: '/api/v1/admin/filter/blocks',
    operation_id: 'listFilterBlocks',
    summary: 'Recent text-filter blocks, newest first',
    tags: ['filter'],
    auth: 'session',
    permissions: ['filter.read'],
    rate_limit: 'global',
    request: { query: paginationQuery({ defaultLimit: 20, maxLimit: 100 }) },
    responses: { 200: { description: 'Blocked inputs', schema: pageSchema(decisionSchema) } },
    handler: async ({ ctx, query }) => {
      const rows = await listFilterDecisions(ctx.db, {
        kind: 'block',
        after: decodeCursor(position, query.cursor),
        limit: query.limit + 1,
      });
      return decisionPage(rows, query.limit);
    },
  });

  router.route({
    method: 'GET',
    path: '/api/v1/admin/filter/unknowns',
    operation_id: 'listFilterUnknowns',
    summary: 'Recent text-filter unknowns, newest first',
    tags: ['filter'],
    auth: 'session',
    permissions: ['filter.read'],
    rate_limit: 'global',
    request: { query: paginationQuery({ defaultLimit: 20, maxLimit: 100 }) },
    responses: { 200: { description: 'Unknown inputs', schema: pageSchema(decisionSchema) } },
    handler: async ({ ctx, query }) => {
      const rows = await listFilterDecisions(ctx.db, {
        kind: 'unknown',
        after: decodeCursor(position, query.cursor),
        limit: query.limit + 1,
      });
      return decisionPage(rows, query.limit);
    },
  });

  router.route({
    method: 'GET',
    path: '/api/v1/admin/filter/allowlist',
    operation_id: 'listFilterAllowlist',
    summary: 'Words the text filter always allows',
    tags: ['filter'],
    auth: 'session',
    permissions: ['filter.read'],
    rate_limit: 'global',
    responses: {
      200: {
        description: 'Allowlist',
        schema: z.object({ items: z.array(listEntrySchema) }),
      },
    },
    handler: ({ ctx }) => {
      const filter = requireTextFilter(ctx);
      return Promise.resolve({
        status: 200 as const,
        headers: NO_STORE,
        body: { items: listedWords(filter.fileAllow, filter.lists.allow) },
      });
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/admin/filter/allowlist',
    operation_id: 'addFilterAllowlist',
    summary: 'Add a word to the text-filter allowlist',
    tags: ['filter'],
    auth: 'session',
    permissions: ['filter.manage'],
    rate_limit: 'global',
    request: { body: wordBody },
    responses: { 200: { description: 'The entry', schema: listEntrySchema } },
    errors: ['FILTER_ENTRY_NOT_FOUND'],
    handler: async ({ ctx, identity, body }) => {
      const word = normalize(body.word);
      if (word === '') throw new ProblemError('FILTER_ENTRY_NOT_FOUND');
      const filter = requireTextFilter(ctx);
      filter.addAllow(word);
      await addListEntry(ctx.db, { list: 'allow', word, actor: staffActor(identity) });
      ctx.outbox.wake();
      return {
        status: 200,
        headers: NO_STORE,
        body: { word, source: filter.fileAllow.has(word) ? ('file' as const) : ('admin' as const) },
      };
    },
  });

  router.route({
    method: 'DELETE',
    path: '/api/v1/admin/filter/allowlist/:word',
    operation_id: 'removeFilterAllowlist',
    summary: 'Remove an admin-added allowlist word',
    tags: ['filter'],
    auth: 'session',
    permissions: ['filter.manage'],
    rate_limit: 'global',
    request: { params: wordParam },
    responses: { 204: { description: 'Removed' } },
    errors: ['FILTER_ENTRY_NOT_FOUND'],
    handler: async ({ ctx, identity, params }) => {
      const word = normalizedWord(params.word);
      const removed = await removeListEntry(ctx.db, {
        list: 'allow',
        word,
        actor: staffActor(identity),
      });
      if (!removed) throw new ProblemError('FILTER_ENTRY_NOT_FOUND');
      const filter = requireTextFilter(ctx);
      if (!filter.fileAllow.has(word)) filter.removeAllow(word);
      ctx.outbox.wake();
      return { status: 204 as const, headers: NO_STORE };
    },
  });

  router.route({
    method: 'GET',
    path: '/api/v1/admin/filter/blocklist',
    operation_id: 'listFilterBlocklist',
    summary: 'Extra words the text filter blocks',
    tags: ['filter'],
    auth: 'session',
    permissions: ['filter.read'],
    rate_limit: 'global',
    responses: {
      200: {
        description: 'Extra blocklist',
        schema: z.object({ items: z.array(listEntrySchema) }),
      },
    },
    handler: ({ ctx }) => {
      const filter = requireTextFilter(ctx);
      return Promise.resolve({
        status: 200 as const,
        headers: NO_STORE,
        body: { items: listedWords(filter.fileExtra, filter.lists.blockExtra) },
      });
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/admin/filter/blocklist',
    operation_id: 'addFilterBlocklist',
    summary: 'Add a word to the extra blocklist',
    tags: ['filter'],
    auth: 'session',
    permissions: ['filter.manage'],
    rate_limit: 'global',
    request: { body: wordBody },
    responses: { 200: { description: 'The entry', schema: listEntrySchema } },
    errors: ['FILTER_ENTRY_NOT_FOUND'],
    handler: async ({ ctx, identity, body }) => {
      const word = normalize(body.word);
      if (word === '') throw new ProblemError('FILTER_ENTRY_NOT_FOUND');
      const filter = requireTextFilter(ctx);
      filter.addExtraBlock(word);
      await addListEntry(ctx.db, { list: 'extra_block', word, actor: staffActor(identity) });
      ctx.outbox.wake();
      return {
        status: 200,
        headers: NO_STORE,
        body: { word, source: filter.fileExtra.has(word) ? ('file' as const) : ('admin' as const) },
      };
    },
  });

  router.route({
    method: 'DELETE',
    path: '/api/v1/admin/filter/blocklist/:word',
    operation_id: 'removeFilterBlocklist',
    summary: 'Remove an admin-added extra-block word',
    tags: ['filter'],
    auth: 'session',
    permissions: ['filter.manage'],
    rate_limit: 'global',
    request: { params: wordParam },
    responses: { 204: { description: 'Removed' } },
    errors: ['FILTER_ENTRY_NOT_FOUND'],
    handler: async ({ ctx, identity, params }) => {
      const word = normalizedWord(params.word);
      const removed = await removeListEntry(ctx.db, {
        list: 'extra_block',
        word,
        actor: staffActor(identity),
      });
      if (!removed) throw new ProblemError('FILTER_ENTRY_NOT_FOUND');
      const filter = requireTextFilter(ctx);
      if (!filter.fileExtra.has(word)) filter.removeExtraBlock(word);
      ctx.outbox.wake();
      return { status: 204 as const, headers: NO_STORE };
    },
  });
}
