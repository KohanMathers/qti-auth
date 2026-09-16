import { SpanKind } from '@opentelemetry/api';
import type { CompiledQuery, DatabaseConnection, Dialect, Driver } from 'kysely';

import { withSpan } from './spans.ts';

export interface TracedDialectOptions {
  namespace: string;
}

export function queryOperation(query: CompiledQuery): string {
  const node = /^(\w+)QueryNode$/.exec(query.query.kind)?.[1];
  if (node !== undefined) return node.toLowerCase();
  return /^\s*([a-z]+)/i.exec(query.sql)?.[1]?.toLowerCase() ?? 'query';
}

function tracedConnection(
  connection: DatabaseConnection,
  options: TracedDialectOptions,
): DatabaseConnection {
  const traced: DatabaseConnection = {
    executeQuery: (query, abort) => {
      const operation = queryOperation(query);
      return withSpan(
        `${operation} ${options.namespace}`,
        {
          kind: SpanKind.CLIENT,
          attributes: {
            'db.system.name': 'postgresql',
            'db.namespace': options.namespace,
            'db.operation.name': operation,
            'db.query.text': query.sql,
          },
        },
        () => connection.executeQuery(query, abort),
      );
    },
    streamQuery: (query, chunkSize, abort) => connection.streamQuery(query, chunkSize, abort),
  };
  if (connection.cancelQuery) traced.cancelQuery = connection.cancelQuery.bind(connection);
  if (connection.killSession) traced.killSession = connection.killSession.bind(connection);
  if (connection.collectSessionInfo) {
    traced.collectSessionInfo = connection.collectSessionInfo.bind(connection);
  }
  return traced;
}

function tracedDriver(driver: Driver, options: TracedDialectOptions): Driver {
  const inner = new WeakMap<DatabaseConnection, DatabaseConnection>();
  const unwrap = (connection: DatabaseConnection) => inner.get(connection) ?? connection;

  const traced: Driver = {
    init: (abort) => driver.init(abort),
    acquireConnection: async (abort) => {
      const connection = await driver.acquireConnection(abort);
      const wrapped = tracedConnection(connection, options);
      inner.set(wrapped, connection);
      return wrapped;
    },
    beginTransaction: (connection, settings) =>
      driver.beginTransaction(unwrap(connection), settings),
    commitTransaction: (connection) => driver.commitTransaction(unwrap(connection)),
    rollbackTransaction: (connection) => driver.rollbackTransaction(unwrap(connection)),
    releaseConnection: (connection, abort) => driver.releaseConnection(unwrap(connection), abort),
    destroy: (abort) => driver.destroy(abort),
  };
  for (const method of ['savepoint', 'rollbackToSavepoint', 'releaseSavepoint'] as const) {
    const original = driver[method]?.bind(driver);
    if (original) {
      traced[method] = (connection, name, compile) => original(unwrap(connection), name, compile);
    }
  }
  return traced;
}

export function tracedDialect(dialect: Dialect, options: TracedDialectOptions): Dialect {
  return {
    createAdapter: () => dialect.createAdapter(),
    createDriver: () => tracedDriver(dialect.createDriver(), options),
    createIntrospector: (db) => dialect.createIntrospector(db),
    createQueryCompiler: () => dialect.createQueryCompiler(),
  };
}
