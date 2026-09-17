import { randomUUIDv7 } from 'node:crypto';

import { deletedRows } from '@qtiauth/db';
import { type FilterResult, inputHash, type TextFilter } from '@qtiauth/text-filter';
import type { Kysely } from 'kysely';

import type { Database, FilterList } from './database.ts';
import { textFilterOf } from './filter-state.ts';
import { identityMetrics } from './metrics.ts';
import type { Context } from './service.ts';

export function requireTextFilter(ctx: Context): TextFilter {
  const filter = textFilterOf(ctx);
  if (filter === undefined) {
    throw new Error('Text filter is not attached');
  }
  return filter;
}

export async function applyFilter(
  ctx: Context,
  raw: string,
  context: string,
): Promise<FilterResult> {
  const result = requireTextFilter(ctx).check(raw);
  identityMetrics(ctx.metrics).filterDecision(result.rule);
  await ctx.db
    .insertInto('filter_decisions')
    .values({
      id: randomUUIDv7(),
      input_hash: inputHash(raw),
      raw_input: raw,
      normalized: result.normalized,
      decision: result.decision,
      rule: result.rule,
      matched_entry: result.matched,
      context,
    })
    .execute();
  return result;
}

export async function loadFilterOverlay(db: Kysely<Database>, filter: TextFilter): Promise<void> {
  const rows = await db.selectFrom('filter_list_entries').select(['list', 'word']).execute();
  for (const row of rows) {
    if (row.list === 'allow') filter.addAllow(row.word);
    else filter.addExtraBlock(row.word);
  }
}

export async function addListEntry(
  db: Kysely<Database>,
  list: FilterList,
  word: string,
): Promise<void> {
  await db
    .insertInto('filter_list_entries')
    .values({ list, word })
    .onConflict((conflict) => conflict.columns(['list', 'word']).doNothing())
    .execute();
}

export async function removeListEntry(
  db: Kysely<Database>,
  list: FilterList,
  word: string,
): Promise<boolean> {
  const result = await db
    .deleteFrom('filter_list_entries')
    .where('list', '=', list)
    .where('word', '=', word)
    .execute();
  return deletedRows(result) > 0;
}

export async function listFilterDecisions(
  db: Kysely<Database>,
  options: {
    kind: 'block' | 'unknown';
    after: { created_at: string; id: string } | undefined;
    limit: number;
  },
): Promise<
  {
    id: string;
    input_hash: string;
    raw_input: string | null;
    normalized: string;
    decision: 'allow' | 'block';
    rule: string;
    matched_entry: string | null;
    context: string;
    created_at: Date;
  }[]
> {
  let query = db.selectFrom('filter_decisions').selectAll();
  query =
    options.kind === 'block'
      ? query.where('decision', '=', 'block')
      : query.where('rule', '=', 'unknown');
  query = query.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(options.limit);
  const { after } = options;
  if (after !== undefined) {
    const createdAt = new Date(after.created_at);
    query = query.where((eb) =>
      eb.or([
        eb('created_at', '<', createdAt),
        eb.and([eb('created_at', '=', createdAt), eb('id', '<', after.id)]),
      ]),
    );
  }
  return query.execute();
}

export async function sweepFilterDecisions(
  db: Kysely<Database>,
  options: { retention: number; now: Date },
): Promise<number> {
  const cutoff = new Date(options.now.getTime() - options.retention);
  const result = await db.deleteFrom('filter_decisions').where('created_at', '<', cutoff).execute();
  return deletedRows(result);
}
