import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import {
  CompiledQuery,
  type DatabaseConnection,
  type Driver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  sql,
} from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { queryOperation, tracedDialect } from './kysely.ts';
import { withSpan } from './spans.ts';
import { startTestTracing, type TestTracing } from './testing.ts';

interface Tables {
  users: { id: string; state: string };
}

let tracing: TestTracing;
let raw: DatabaseConnection;
let released: DatabaseConnection[];
let transactions: DatabaseConnection[];

function fakeDriver(): Driver {
  return {
    init: () => Promise.resolve(),
    acquireConnection: () => Promise.resolve(raw),
    beginTransaction: (connection) => {
      transactions.push(connection);
      return Promise.resolve();
    },
    commitTransaction: () => Promise.resolve(),
    rollbackTransaction: () => Promise.resolve(),
    releaseConnection: (connection) => {
      released.push(connection);
      return Promise.resolve();
    },
    destroy: () => Promise.resolve(),
  };
}

function database(): Kysely<Tables> {
  return new Kysely<Tables>({
    dialect: tracedDialect(
      {
        createAdapter: () => new PostgresAdapter(),
        createDriver: fakeDriver,
        createIntrospector: (db) => new PostgresIntrospector(db),
        createQueryCompiler: () => new PostgresQueryCompiler(),
      },
      { namespace: 'qtiauth|identity' },
    ),
  });
}

beforeAll(() => {
  tracing = startTestTracing();
});

beforeEach(() => {
  tracing.reset();
  released = [];
  transactions = [];
  raw = {
    executeQuery: (query) =>
      query.sql.includes('broken')
        ? Promise.reject(new Error('relation "broken" does not exist'))
        : Promise.resolve({ rows: [] }),
    async *streamQuery() {
      yield await Promise.resolve({ rows: [] });
    },
  };
});

afterAll(async () => {
  await tracing.shutdown();
});

describe('tracedDialect', () => {
  it('traces each query as a child of the active span', async () => {
    const db = database();
    await withSpan('request', {}, async () => {
      await db.selectFrom('users').selectAll().where('id', '=', 'u1').execute();
      await db.updateTable('users').set({ state: 'banned' }).where('id', '=', 'u1').execute();
    });

    const [select, update, request] = tracing.spans();
    expect(select?.name).toBe('select qtiauth|identity');
    expect(select?.kind).toBe(SpanKind.CLIENT);
    expect(select?.parentSpanContext?.spanId).toBe(request?.spanContext().spanId);
    expect(select?.attributes).toEqual({
      'db.system.name': 'postgresql',
      'db.namespace': 'qtiauth|identity',
      'db.operation.name': 'select',
      'db.query.text': 'select * from "users" where "id" = $1',
    });
    expect(update?.attributes['db.operation.name']).toBe('update');
    expect(JSON.stringify(tracing.spans().map((s) => s.attributes))).not.toContain('banned');
  });

  it('hands the driver its own connection back', async () => {
    const db = database();
    await db.transaction().execute((trx) => trx.selectFrom('users').selectAll().execute());
    expect(transactions).toEqual([raw]);
    expect(released).toEqual([raw]);
  });

  it('marks failed queries', async () => {
    await expect(sql`select * from broken`.execute(database())).rejects.toThrow('does not exist');
    expect(tracing.spans()[0]?.status.code).toBe(SpanStatusCode.ERROR);
  });
});

describe('queryOperation', () => {
  it('names raw queries by their first keyword', () => {
    expect(queryOperation(CompiledQuery.raw('  WITH x as (select 1) select * from x'))).toBe(
      'with',
    );
    expect(queryOperation(CompiledQuery.raw(''))).toBe('query');
  });
});
