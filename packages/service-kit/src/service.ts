import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import { serve } from '@hono/node-server';
import {
  type Bus,
  type BusMetrics,
  busHealthCheck,
  connectBus,
  type OutboxRelay,
  prometheusBusMetrics,
  provisionStreams,
  serveRpc,
  startOutboxRelay,
} from '@qtiauth/bus';
import {
  ConfigError,
  type DbSchema,
  loadConfig,
  resolveConfigPath,
  type SectionName,
  type ServiceConfig,
  serviceConfigSchema,
} from '@qtiauth/config';
import {
  createDb,
  databaseHealthCheck,
  type Migration,
  PendingMigrationsError,
  runStartupMigrations,
} from '@qtiauth/db';
import {
  createLogger,
  createMetrics,
  type HealthCheck,
  type LogDestination,
  type Logger,
  type Metrics,
  readiness,
  startTracing,
} from '@qtiauth/observability';
import type { Kysely } from 'kysely';

import { type Announcer, startAnnouncer } from './announce.ts';
import { type DataRightsHandlers, registerDataRights } from './data-rights.ts';
import { createHttpApp } from './http.ts';
import type { IdentityKeySource } from './identity.ts';
import { busIdentityKeys } from './keys.ts';
import type { NotificationRegistry } from './notifications.ts';
import { openApiDocument } from './openapi.ts';
import type { PermissionRegistry } from './permissions.ts';
import type { ErrorRegistry } from './problems.ts';
import { createRouter, type RouteModule, type Router } from './routes.ts';
import { closeServer, listen, unwind } from './server.ts';

export const BASE_SECTIONS = ['service', 'observability', 'bus', 'database', 'migrations'] as const;
export type BaseSection = (typeof BASE_SECTIONS)[number];

export const OPENAPI_METHOD = 'openapi';

const SERVICE_NAME = /^[a-z][a-z0-9_]*$/;

export interface DatabaseDefinition {
  schema: DbSchema;
  migrations: () => Promise<readonly Migration[]>;
}

export interface ServiceDefinition {
  name: string;
  version: string;
  module: RouteModule;
  sections?: readonly SectionName[];
  database?: DatabaseDefinition;
  permissions?: PermissionRegistry;
  notifications?: NotificationRegistry;
  errors?: ErrorRegistry;
}

type SectionsOf<D extends ServiceDefinition> = D['sections'] extends readonly (infer K)[]
  ? K & SectionName
  : never;
type WithDatabase<D extends ServiceDefinition, T> = D extends { database: DatabaseDefinition }
  ? T
  : undefined;

export type ServiceConfigOf<D extends ServiceDefinition> = ServiceConfig<
  BaseSection | SectionsOf<D>
>;

export interface ServiceContext<D extends ServiceDefinition, DB = unknown> {
  service: string;
  version: string;
  instance_id: string;
  config_path: string;
  config: ServiceConfigOf<D>;
  log: Logger;
  metrics: Metrics;
  busMetrics: BusMetrics;
  bus: Bus;
  db: WithDatabase<D, Kysely<DB>>;
  outbox: WithDatabase<D, OutboxRelay>;
}

export interface Stoppable {
  stop: () => Promise<void>;
}

export interface StartServiceOptions<D extends ServiceDefinition, DB> {
  router: Router<ServiceContext<D, DB>>;
  config?: ServiceConfigOf<D>;
  configPath?: string;
  env?: Readonly<Record<string, string | undefined>>;
  port?: number;
  logDestination?: LogDestination;
  tracing?: boolean;
  identityKeys?: IdentityKeySource;
  readinessChecks?: (context: ServiceContext<D, DB>) => Record<string, HealthCheck>;
  dataRights?: (context: ServiceContext<D, DB>) => DataRightsHandlers<DB>;
  start?: (context: ServiceContext<D, DB>) => Promise<readonly Stoppable[] | undefined>;
}

export interface RunningService<D extends ServiceDefinition, DB = unknown> {
  context: ServiceContext<D, DB>;
  port: number;
  url: string;
  stop: () => Promise<void>;
}

export class ServiceDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServiceDefinitionError';
  }
}

export function defineService<const D extends ServiceDefinition>(definition: D): D {
  if (!SERVICE_NAME.test(definition.name)) {
    throw new ServiceDefinitionError(
      `Service name ${definition.name} must be lowercase letters, digits and _`,
    );
  }
  if (definition.version.trim() === '') {
    throw new ServiceDefinitionError(`Service ${definition.name} needs a version`);
  }
  return definition;
}

export function serviceSections(definition: ServiceDefinition): SectionName[] {
  return [...new Set<SectionName>([...BASE_SECTIONS, ...(definition.sections ?? [])])];
}

export function serviceSchema(definition: ServiceDefinition) {
  return serviceConfigSchema(serviceSections(definition));
}

export function createServiceRouter<Ctx>(definition: ServiceDefinition): Router<Ctx> {
  return createRouter<Ctx>({
    service: definition.name,
    version: definition.version,
    module: definition.module,
    ...(definition.permissions === undefined ? {} : { permissions: definition.permissions }),
    ...(definition.notifications === undefined ? {} : { notifications: definition.notifications }),
    ...(definition.errors === undefined ? {} : { errors: definition.errors }),
  });
}

export async function startService<const D extends ServiceDefinition, DB = unknown>(
  definition: D,
  options: StartServiceOptions<D, DB>,
): Promise<RunningService<D, DB>> {
  const env = options.env ?? process.env;
  const configPath = options.configPath ?? resolveConfigPath(env);
  const config: ServiceConfigOf<D> =
    options.config ?? (await loadConfig(serviceSchema(definition), { path: configPath, env }));
  const { name, version } = definition;
  const stack: (() => Promise<void>)[] = [];
  const unwindStack = () => unwind(stack.splice(0));

  if (options.tracing ?? true) {
    const tracing = startTracing(config.observability.tracing, name);
    stack.push(() => tracing.shutdown());
  }
  const instanceId = randomUUID();
  const log = createLogger({
    service: name,
    config: config.observability.logs,
    ...(options.logDestination === undefined ? {} : { destination: options.logDestination }),
  }).child({ instance_id: instanceId });

  try {
    const metrics = createMetrics(config.observability.metrics, name);
    const busMetrics = prometheusBusMetrics(metrics);

    let db: Kysely<DB> | undefined;
    if (definition.database) {
      const { schema } = definition.database;
      const created = createDb<DB>(config.database, schema);
      db = created;
      stack.push(() => created.destroy());
      const applied = await runStartupMigrations(created as Kysely<unknown>, {
        service: name,
        schema,
        migrations: await definition.database.migrations(),
        autoApply: config.migrations.auto_apply,
      });
      if (applied.length > 0) log.info('applied migrations', { schema, migrations: applied });
    }

    const bus = await connectBus(config.bus, name);
    stack.push(() => bus.close());
    await provisionStreams(bus.jsm, config.bus);

    let outbox: OutboxRelay | undefined;
    if (db) {
      const relay = startOutboxRelay(bus, db, {
        metrics: busMetrics,
        onError: (error) => {
          log.error('outbox relay failed', { error });
        },
      });
      outbox = relay;
      stack.push(() => relay.stop());
    }

    const context = {
      service: name,
      version,
      instance_id: instanceId,
      config_path: configPath,
      config,
      log,
      metrics,
      busMetrics,
      bus,
      db,
      outbox,
    } as ServiceContext<D, DB>;

    let draining = false;
    const checks: Record<string, HealthCheck> = {
      nats: busHealthCheck(bus),
      ...(db ? { database: databaseHealthCheck(db) } : {}),
      ...options.readinessChecks?.(context),
    };
    const openapi = () => openApiDocument(options.router);

    const openapiServer = serveRpc(bus, {
      method: OPENAPI_METHOD,
      handler: () => Promise.resolve(openapi()),
      onError: (error) => {
        log.error('openapi request failed', { error });
      },
    });
    stack.push(() => openapiServer.stop());

    if (options.dataRights) {
      if (!db) {
        throw new ServiceDefinitionError(`Service ${name} needs a database to handle data rights`);
      }
      const dataRights = await registerDataRights(bus, db, options.dataRights(context), {
        metrics: busMetrics,
        onError: (error, where) => {
          log.error('data rights handler failed', { error, subject: where.subject });
        },
      });
      stack.push(() => dataRights.stop());
    }

    for (const task of (await options.start?.(context)) ?? []) {
      stack.push(() => task.stop());
    }

    const app = createHttpApp({
      router: options.router,
      context,
      log,
      metrics,
      identityKeys:
        options.identityKeys ?? busIdentityKeys(bus, config.service.identity_tokens.keys_refresh),
      clockTolerance: config.service.identity_tokens.clock_tolerance,
      readiness: async () => {
        const result = await readiness(name, checks, {
          timeout: config.observability.health.check_timeout,
          onError: (check, error) => {
            log.warn(`${check} check failed`, { error });
          },
        });
        return draining ? { ...result, status: 'unavailable' } : result;
      },
      openapi,
    });

    const server = serve({
      fetch: app.fetch,
      port: options.port ?? config.service.http.port,
    }) as Server;
    stack.push(() => closeServer(server, config.service.http.shutdown_timeout));
    const port = await listen(server);

    const announcer: Announcer = startAnnouncer(
      bus,
      {
        service: name,
        instance_id: instanceId,
        version,
        started_at: new Date().toISOString(),
        manifest: options.router.manifest(),
      },
      {
        onError: (error) => {
          log.warn('announce subscription failed', { error });
        },
      },
    );
    stack.push(() => announcer.stop());

    log.info('service started', { version, port });

    let stopping: Promise<void> | undefined;
    return {
      context,
      port,
      url: `http://127.0.0.1:${String(port)}`,
      stop: () => {
        stopping ??= (async () => {
          draining = true;
          log.info('service stopping');
          await unwindStack();
          log.info('service stopped');
        })();
        return stopping;
      },
    };
  } catch (error) {
    log.fatal('service failed to start', { error });
    await unwindStack().catch((cleanupError: unknown) => {
      log.error('cleanup after failed start also failed', { error: cleanupError });
    });
    throw error;
  }
}

export async function runService<const D extends ServiceDefinition, DB = unknown>(
  definition: D,
  options: StartServiceOptions<D, DB>,
): Promise<void> {
  let service: RunningService<D, DB>;
  try {
    service = await startService(definition, options);
  } catch (error) {
    if (error instanceof ConfigError || error instanceof PendingMigrationsError) {
      process.stderr.write(`${error.message}\n`);
    }
    process.exitCode = 1;
    return;
  }

  const { log, config } = service.context;
  const shutdown = (signal: NodeJS.Signals) => {
    log.info('received shutdown signal', { signal });
    const deadline = setTimeout(() => {
      log.fatal('shutdown took too long, exiting');
      process.exit(1);
    }, config.service.http.shutdown_timeout * 2);
    deadline.unref();
    service.stop().then(
      () => {
        process.exitCode = 0;
      },
      (error: unknown) => {
        log.error('shutdown failed', { error });
        process.exitCode = 1;
      },
    );
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
