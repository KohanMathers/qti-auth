import type { Server } from 'node:http';

import { type Http2Bindings, type HttpBindings, serve } from '@hono/node-server';
import { consumeCron, consumeIdempotentEvents, rpcRequest, serveRpc } from '@qtiauth/bus';
import {
  closeServer,
  IDENTITY_KEYS_METHOD,
  listen,
  OPENAPI_METHOD,
  type OpenApiDocument,
  openApiDocument,
  RESOLVE_SESSION_METHOD,
  RESOLVE_SESSION_SERVICE,
  type StartServiceOptions,
  type Stoppable,
  unwind,
} from '@qtiauth/service-kit';
import { closeValkey, connectValkey, type Valkey, valkeyHealthCheck } from '@qtiauth/valkey';

import { trustedProxies } from './client-ip.ts';
import { allowedOrigins } from './cors.ts';
import { createServiceRegistry, type ServiceRegistry, startDiscovery } from './discovery.ts';
import { parseEncryptionKey } from './envelope.ts';
import { createGatewayHandler, GATEWAY_SERVICE, type GatewayHandler } from './gateway.ts';
import { hstsValue } from './headers.ts';
import { type Keyring, kvKeySetStore, type KeySetStore, openKeyring } from './identity-keys.ts';
import { featuresReport, healthReport } from './meta.ts';
import { prometheusGatewayMetrics } from './metrics.ts';
import { mergeOpenApi } from './openapi.ts';
import { upstreamUrl } from './proxy.ts';
import {
  createRateLimiter,
  prometheusRateLimitMetrics,
  type RateLimitStore,
  valkeyRateLimitStore,
} from './rate-limit.ts';
import { buildRouteTable, type RouteTable } from './routes.ts';
import {
  type Context,
  type definition,
  internalRouter,
  type LocalContext,
  router,
} from './service.ts';
import {
  createSessionResolver,
  invalidationTargets,
  prometheusSessionMetrics,
  SESSION_EVENTS,
  type SessionCache,
  valkeySessionCache,
} from './sessions.ts';
import { listenPorts, resolveSurfaces } from './surfaces.ts';

export const KEY_ROTATION_JOB = 'keys.rotate';
export const SESSION_CACHE_CONSUMER = 'session_cache';

export interface GatewayOptions {
  hostPort?: number;
  keyStore?: KeySetStore;
  rateLimitStore?: RateLimitStore;
  sessionCache?: SessionCache;
}

export interface RunningGateway extends Stoppable {
  ports: number[];
  handler: GatewayHandler;
  keyring: Keyring;
  registry: ServiceRegistry;
  routes: () => RouteTable;
  valkey: Valkey;
}

export class GatewayConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GatewayConfigError';
  }
}

export async function startGateway(
  ctx: Context,
  options: GatewayOptions = {},
): Promise<RunningGateway> {
  const { config, log, bus } = ctx;
  const stack: (() => Promise<void>)[] = [];
  const unwindStack = () => unwind(stack.splice(0));

  try {
    const encryptionKey = parseEncryptionKey(
      config.gateway.identity_keys.encryption_key,
      'gateway.identity_keys.encryption_key',
    );
    const surfaces = resolveSurfaces(config);
    const hostPort = options.hostPort ?? config.gateway.http.port;
    const ports = listenPorts(surfaces, hostPort);
    if (ports.includes(config.service.http.port)) {
      throw new GatewayConfigError(
        `Public port ${String(config.service.http.port)} is also service.http.port. Internal endpoints must not be public.`,
      );
    }

    const metrics = prometheusGatewayMetrics(ctx.metrics);
    const valkey = connectValkey(config.valkey, GATEWAY_SERVICE, (error) => {
      log.warn('valkey client error', { error });
    });
    stack.push(() => closeValkey(valkey));

    const keyring = await openKeyring({
      store: options.keyStore ?? (await kvKeySetStore(bus)),
      encryptionKey,
      rotateAfter: config.gateway.identity_keys.rotate_after,
      retainAfterRotation: config.gateway.identity_keys.retain_after_rotation,
      onError: (error) => {
        log.warn('identity keys refresh failed', { error });
      },
    });
    metrics.keyLoaded(keyring.activeKeyCreatedAt());

    const jwks = serveRpc(bus, {
      method: IDENTITY_KEYS_METHOD,
      handler: () => keyring.jwks(),
      onError: (error) => {
        log.error('identity keys request failed', { error });
      },
    });
    stack.push(() => jwks.stop());

    const refreshKeys = setInterval(() => {
      keyring.refresh().then(
        () => {
          metrics.keyLoaded(keyring.activeKeyCreatedAt());
        },
        (error: unknown) => {
          log.warn('identity keys refresh failed', { error });
        },
      );
    }, config.gateway.identity_keys.refresh);
    stack.push(() => {
      clearInterval(refreshKeys);
      return Promise.resolve();
    });

    const rotation = await consumeCron(bus, {
      job: KEY_ROTATION_JOB,
      metrics: ctx.busMetrics,
      handler: async () => {
        if (await keyring.rotateIfDue()) {
          metrics.keyRotated();
          log.info('identity key rotated', { kid: keyring.signingKey().kid });
        }
        metrics.keyLoaded(keyring.activeKeyCreatedAt());
      },
      onError: (error) => {
        log.error('identity key rotation failed', { error });
      },
    });
    stack.push(() => rotation.stop());

    const sessions = createSessionResolver({
      cache: options.sessionCache ?? valkeySessionCache(valkey),
      cacheTtl: config.gateway.session_cache.ttl,
      metrics: prometheusSessionMetrics(ctx.metrics),
      resolve: (request) =>
        rpcRequest(bus, RESOLVE_SESSION_SERVICE, RESOLVE_SESSION_METHOD, request, {
          metrics: ctx.busMetrics,
        }),
      onError: (message, error) => {
        log.warn(message, { error });
      },
    });
    const invalidation = await consumeIdempotentEvents(bus, {
      name: SESSION_CACHE_CONSUMER,
      types: SESSION_EVENTS,
      metrics: ctx.busMetrics,
      handler: async (event) => {
        await Promise.all(
          invalidationTargets(event).map((target) => sessions.invalidate(target.kind, target.id)),
        );
      },
      onError: (error, message) => {
        log.error('session cache invalidation failed', { error, subject: message.subject });
      },
    });
    stack.push(() => invalidation.stop());

    const rateLimiter = createRateLimiter({
      policies: config.rate_limits,
      store: options.rateLimitStore ?? valkeyRateLimitStore(valkey),
      metrics: prometheusRateLimitMetrics(ctx.metrics),
      onStoreError: (policy, error) => {
        log.warn('rate limit store unavailable', { policy, error });
      },
    });

    const startedAt = Date.now();
    const registry = createServiceRegistry({ expiry: config.gateway.discovery.expiry });
    const localManifest = router.manifest();
    let table = buildRouteTable({
      surfaces,
      manifests: [localManifest],
      rateLimits: rateLimiter.policies,
    });
    const documents = new Map<string, Promise<OpenApiDocument | null>>();

    const rebuild = () => {
      table = buildRouteTable({
        surfaces,
        rateLimits: rateLimiter.policies,
        manifests: [
          localManifest,
          ...registry
            .services()
            .filter((service) => service.name !== GATEWAY_SERVICE)
            .map((service) => service.manifest),
        ],
      });
      for (const problem of table.problems) log.warn('route problem', { ...problem });
    };

    const discovery = startDiscovery(bus, registry, {
      interval: config.gateway.discovery.interval,
      onChange: () => {
        rebuild();
        documents.clear();
        log.info('route table updated', {
          services: registry.services().map((service) => service.name),
          routes: table.routes.length,
        });
      },
      onInvalid: (error) => {
        log.warn('ignored an invalid service announcement', { error });
      },
    });
    stack.push(() => discovery.stop());

    const documentFor = (service: string, version: string): Promise<OpenApiDocument | null> => {
      const key = `${service}@${version}`;
      let pending = documents.get(key);
      if (!pending) {
        pending = rpcRequest<OpenApiDocument>(
          bus,
          service,
          OPENAPI_METHOD,
          {},
          { metrics: ctx.busMetrics },
        ).then(
          (result) => {
            if (result.status === 'ok') return result.data;
            documents.delete(key);
            return null;
          },
          () => {
            documents.delete(key);
            return null;
          },
        );
        documents.set(key, pending);
      }
      return pending;
    };

    const local: Omit<LocalContext, 'surface'> = {
      health: () =>
        healthReport({
          config,
          services: registry.services(),
          routeProblems: table.problems,
          starting: Date.now() - startedAt < config.gateway.discovery.startup_grace,
          surfaces,
        }),
      features: () =>
        featuresReport({ config, surfaces, isRunning: (service) => registry.isRunning(service) }),
      openapi: async (surface) => {
        const services = registry.services().filter((service) => service.name !== GATEWAY_SERVICE);
        const entries = await Promise.all(
          services.map(
            async (service) =>
              [service.name, await documentFor(service.name, service.version)] as const,
          ),
        );
        return mergeOpenApi({
          surface,
          table,
          documents: new Map([[GATEWAY_SERVICE, openApiDocument(router)], ...entries]),
          title: `${config.branding.product_name} API`,
          version: ctx.version,
        });
      },
    };

    const handler = createGatewayHandler({
      config,
      log,
      metrics,
      surfaces,
      allowedOrigins: allowedOrigins(config, surfaces),
      proxies: trustedProxies(config.network.trusted_proxies),
      hsts: hstsValue(config.gateway.hsts),
      routes: () => table,
      rateLimiter,
      sessions,
      signingKey: () => keyring.signingKey(),
      local: router,
      localContext: (surface) => ({ ...local, surface }),
      upstreamUrl: (service) => upstreamUrl(config, service),
    });

    const listening: number[] = [];
    for (const port of ports) {
      const server = serve({
        port,
        fetch: (request: Request, env: HttpBindings | Http2Bindings) =>
          handler(request, {
            peer: env.incoming.socket.remoteAddress,
            localPort: env.incoming.socket.localPort ?? port,
          }),
      }) as Server;
      stack.push(() => closeServer(server, config.service.http.shutdown_timeout));
      listening.push(await listen(server));
    }
    log.info('gateway listening', { ports: listening });

    return {
      ports: listening,
      handler,
      keyring,
      registry,
      routes: () => table,
      valkey,
      stop: unwindStack,
    };
  } catch (error) {
    await unwindStack().catch((cleanupError: unknown) => {
      log.error('cleanup after failed start also failed', { error: cleanupError });
    });
    throw error;
  }
}

export function gatewayService(options: GatewayOptions = {}) {
  let running: RunningGateway | undefined;
  const serviceOptions = {
    router: internalRouter,
    readinessChecks: () => ({
      valkey: () =>
        running
          ? valkeyHealthCheck(running.valkey)()
          : Promise.reject(new Error('The gateway has not started')),
    }),
    start: async (ctx: Context) => {
      running = await startGateway(ctx, options);
      return [running];
    },
  } satisfies StartServiceOptions<typeof definition, unknown>;
  return {
    options: serviceOptions,
    gateway: (): RunningGateway => {
      if (!running) throw new Error('The gateway has not started');
      return running;
    },
  };
}
