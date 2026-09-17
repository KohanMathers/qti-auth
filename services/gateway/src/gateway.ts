import { randomUUID } from 'node:crypto';

import type { QtiauthConfig } from '@qtiauth/config';
import { type Logger, traceHttpRequest } from '@qtiauth/observability';
import {
  type HandlerResult,
  IDENTITY_HEADER,
  problemDetails,
  ProblemError,
  problemResponse,
  REQUEST_ID_HEADER,
  type ResponseMap,
  type Router,
  signIdentityToken,
  type SigningKey,
} from '@qtiauth/service-kit';

import { clientIp, type TrustedProxies } from './client-ip.ts';
import { applyCors, isPreflight, isStateChanging, preflightResponse } from './cors.ts';
import { ERRORS } from './errors.ts';
import { applySecurityHeaders } from './headers.ts';
import type { GatewayMetrics } from './metrics.ts';
import { checkPolicy, identityFor } from './policy.ts';
import {
  type ForwardResult,
  forward,
  type ForwardRequest,
  readBody,
  upstreamHeaders,
} from './proxy.ts';
import {
  GLOBAL_POLICY,
  type RateLimiter,
  type RateLimitResult,
  rateLimitHeaders,
} from './rate-limit.ts';
import type { RouteLookup, RouteTable } from './routes.ts';
import type { LocalContext } from './service.ts';
import {
  clearSessionCookie,
  readCookie,
  type ResolvedSession,
  sessionCookieName,
  type SessionResolver,
} from './sessions.ts';
import { matchSurface, requestHost, type Surface } from './surfaces.ts';

export type GatewayConfig = Pick<QtiauthConfig, 'cookies' | 'gateway' | 'security'>;

export const GATEWAY_SERVICE = 'gateway';

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const JSON_CONTENT_TYPE = /^application\/(?:[\w.+-]+\+)?json\s*(?:;|$)/i;

export interface Connection {
  peer: string | undefined;
  localPort: number;
}

export interface GatewayHandlerOptions {
  config: GatewayConfig;
  log: Logger;
  metrics: GatewayMetrics;
  surfaces: readonly Surface[];
  allowedOrigins: ReadonlySet<string>;
  proxies: TrustedProxies;
  hsts: string;
  routes: () => RouteTable;
  rateLimiter: RateLimiter;
  sessions: SessionResolver;
  signingKey: () => SigningKey;
  local: Router<LocalContext>;
  localContext: (surface: Surface) => LocalContext;
  upstreamUrl: (service: string) => string;
  forward?: (request: ForwardRequest) => Promise<ForwardResult>;
  now?: () => number;
}

export type GatewayHandler = (request: Request, connection: Connection) => Promise<Response>;

function requestIdOf(request: Request): string {
  const header = request.headers.get(REQUEST_ID_HEADER);
  return header !== null && REQUEST_ID.test(header) ? header : randomUUID();
}

function toResponse(result: HandlerResult<ResponseMap>): Response {
  if (result instanceof Response) return result;
  const headers = new Headers(result.headers);
  if ('body' in result) return Response.json(result.body, { status: result.status, headers });
  return new Response(null, { status: result.status, headers });
}

function lookupMethod(method: string): string {
  return method === 'HEAD' ? 'GET' : method;
}

export function createGatewayHandler(options: GatewayHandlerOptions): GatewayHandler {
  const { config, log, metrics, rateLimiter, sessions } = options;
  const now = options.now ?? Date.now;
  const send = options.forward ?? forward;
  const cookieName = sessionCookieName(config.cookies);
  const clearCookie = clearSessionCookie(config.cookies);
  const localRoutes = new Map(
    options.local.routes.map((route) => [`${route.method} ${route.path}`, route]),
  );

  return async (request, connection) => {
    const started = performance.now();
    const url = new URL(request.url);
    const requestId = requestIdOf(request);
    const origin = request.headers.get('origin');
    const host = requestHost(request.headers.get('host'));
    const ip = clientIp(connection.peer, request.headers.get('x-forwarded-for'), options.proxies);
    const matched = matchSurface(options.surfaces, host, connection.localPort, url.pathname);
    const table = options.routes();
    const lookup: RouteLookup = matched
      ? table.lookup(matched.surface.name, lookupMethod(request.method), matched.path)
      : { status: 'not_found' };
    const mount = lookup.status === 'found' ? lookup.match.mount : undefined;
    const routeLabel = mount?.route.route.path ?? 'unmatched';
    const surfaceLabel = matched?.surface.name ?? 'none';

    let requestLog = log.child({ request_id: requestId });
    let requestBytes = 0;
    let limits: RateLimitResult | undefined;
    let staleCookie = false;
    let upstream: string | undefined;

    const problem = (code: string, init: ConstructorParameters<typeof ProblemError>[1] = {}) =>
      problemResponse(
        problemDetails(ERRORS, new ProblemError(code, init), requestId),
        init.headers,
      );

    const finish = (response: Response): Response => {
      const headers = response.headers;
      applySecurityHeaders(headers, options.hsts);
      if (matched) applyCors(headers, origin, options.allowedOrigins);
      if (limits) {
        for (const [name, value] of Object.entries(rateLimitHeaders(limits)))
          headers.set(name, value);
      }
      if (staleCookie) headers.append('Set-Cookie', clearCookie);
      headers.set(REQUEST_ID_HEADER, requestId);

      const length = headers.get('content-length');
      metrics.request(
        {
          surface: surfaceLabel,
          route: routeLabel,
          method: request.method,
          status: response.status,
        },
        (performance.now() - started) / 1000,
        requestBytes,
        length === null ? null : Number(length),
      );
      requestLog.info('request', {
        surface: surfaceLabel,
        route: routeLabel,
        method: request.method,
        status: response.status,
        duration_ms: Math.round(performance.now() - started),
        ...(upstream === undefined ? {} : { upstream }),
      });
      return response;
    };

    const limit = async (
      policy: string,
      session: ResolvedSession | null,
      body: Uint8Array | null,
    ) => {
      let parsed: Promise<unknown> | undefined;
      limits = await rateLimiter.check(policy, {
        ip,
        user: session?.user_id ?? null,
        client: null,
        body: () => {
          parsed ??= Promise.resolve().then(() => {
            if (
              body === null ||
              !JSON_CONTENT_TYPE.test(request.headers.get('content-type') ?? '')
            ) {
              return null;
            }
            try {
              return JSON.parse(new TextDecoder().decode(body)) as unknown;
            } catch {
              return null;
            }
          });
          return parsed;
        },
      });
      if (limits.status === 'limited') return problem('RATE_LIMITED');
      if (limits.status === 'unavailable') return problem('RATE_LIMIT_UNAVAILABLE');
      return null;
    };

    const handle = async (): Promise<Response> => {
      if (!matched) {
        return (await limit(GLOBAL_POLICY, null, null)) ?? problem('NOT_FOUND');
      }
      if (isPreflight(request)) {
        return (
          (await limit(GLOBAL_POLICY, null, null)) ??
          preflightResponse(request, options.allowedOrigins)
        );
      }
      if (lookup.status !== 'found') {
        const refused = await limit(GLOBAL_POLICY, null, null);
        if (refused) return refused;
        if (lookup.status === 'method_not_allowed') {
          return problem('METHOD_NOT_ALLOWED', { headers: { Allow: lookup.allowed.join(', ') } });
        }
        return problem('NOT_FOUND');
      }

      const { mount: found } = lookup.match;
      const entry = found.route;
      const { route } = entry;

      const read = await readBody(request, config.gateway.http.max_body_size);
      if (read.status === 'too_large') return problem('PAYLOAD_TOO_LARGE');
      requestBytes = read.body?.byteLength ?? 0;

      let session: ResolvedSession | null = null;
      const token = readCookie(request.headers.get('cookie'), cookieName);
      if (route.auth === 'session' && token !== null) {
        const resolved = await sessions.resolve(token, config.cookies.domain ?? host ?? '');
        if (resolved.status === 'unavailable') return problem('SERVICE_UNAVAILABLE');
        if (resolved.status === 'ok') {
          session = resolved.session;
          requestLog = requestLog.child({ user_id: session.user_id });
        } else {
          staleCookie = resolved.stale_cookie;
        }
      }

      const refused = await limit(route.rate_limit, session, read.body);
      if (refused) return refused;

      if (isStateChanging(request.method)) {
        const crossOrigin = origin !== null && !options.allowedOrigins.has(origin);
        const missingOrigin = origin === null && route.auth === 'session' && token !== null;
        if (crossOrigin || missingOrigin) return problem('ORIGIN_NOT_ALLOWED');
      }

      const denial = checkPolicy(entry, session, {
        stepUpWindow: config.security.step_up_window,
        now: now(),
      });
      if (denial) {
        return problem(denial.code, {
          ...(denial.extensions === undefined ? {} : { extensions: denial.extensions }),
          ...(denial.code === 'AUTHENTICATION_REQUIRED' && route.auth !== 'session'
            ? { headers: { 'WWW-Authenticate': 'Bearer' } }
            : {}),
        });
      }

      const identity = identityFor(entry, session, requestId);
      if (entry.service === GATEWAY_SERVICE) {
        const local = localRoutes.get(`${route.method} ${route.path}`);
        if (!local) return problem('NOT_FOUND');
        return toResponse(
          await local.handler({
            ctx: options.localContext(matched.surface),
            identity,
            params: undefined,
            query: undefined,
            body: undefined,
            request,
            request_id: requestId,
            log: requestLog,
          }),
        );
      }

      upstream = entry.service;
      const result = await send({
        url: `${options.upstreamUrl(entry.service)}${found.prefix}${matched.path}${url.search}`,
        method: request.method,
        body: read.body,
        timeout: config.gateway.http.upstream_timeout,
        headers: upstreamHeaders(request, {
          [IDENTITY_HEADER]: signIdentityToken(identity, {
            audience: entry.service,
            key: options.signingKey(),
          }),
          [REQUEST_ID_HEADER]: requestId,
          'x-forwarded-for': ip,
          ...(host === null ? {} : { 'x-forwarded-host': host }),
          'x-forwarded-proto': matched.surface.origins[0]?.startsWith('http:') ? 'http' : 'https',
        }),
      });
      if (result.status === 'ok') return result.response;
      metrics.upstreamError(entry.service, result.status);
      if (result.status === 'timeout') return problem('UPSTREAM_TIMEOUT');
      requestLog.warn('service unreachable', { upstream: entry.service, error: result.error });
      return problem('SERVICE_UNAVAILABLE');
    };

    const response = await traceHttpRequest(request, routeLabel, async () => {
      try {
        return await handle();
      } catch (error) {
        requestLog.error('request failed', { error });
        return problem('INTERNAL_ERROR');
      }
    });
    return finish(response);
  };
}
