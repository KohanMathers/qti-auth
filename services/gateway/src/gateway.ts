import type { QtiauthConfig } from '@qtiauth/config';
import type { GeoIp } from '@qtiauth/geoip';
import { type Logger, traceHttpRequest } from '@qtiauth/observability';
import {
  FLOW_BINDING_HEADER,
  IDENTITY_HEADER,
  isJsonRequest,
  parseInput,
  problemDetails,
  ProblemError,
  problemResponse,
  REQUEST_ID_HEADER,
  requestIdOf,
  RESOLVE_SESSION_SERVICE,
  type ResolvedSession,
  REVOKED_SESSIONS_HEADER,
  type Router,
  SESSION_CLEAR_HEADER,
  SESSION_CLIENT_FINGERPRINT_HEADER,
  SESSION_COUNTRY_HEADER,
  SESSION_EXPIRES_HEADER,
  SESSION_RESPONSE_HEADERS,
  SESSION_SCREEN_HEADER,
  SESSION_TIMEZONE_HEADER,
  SESSION_TOKEN_HEADER,
  signIdentityToken,
  type SigningKey,
  toResponse,
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
  bindAttemptCookie,
  bindAttemptCookieName,
  clearSessionCookie,
  flowCookie,
  flowCookieName,
  isSessionToken,
  readCookie,
  sessionCookie,
  sessionCookieName,
  sessionSignals,
  type SessionResolver,
} from './sessions.ts';
import {
  BIND_PATH,
  bindStartUrl,
  isTopLevelNavigation,
  LOGIN_PATH,
  matchSurface,
  needsSessionBinding,
  requestHost,
  surfacePublicUrl,
  type Surface,
} from './surfaces.ts';

export type GatewayConfig = Pick<
  QtiauthConfig,
  'cookies' | 'gateway' | 'security' | 'geoip' | 'session_security' | 'features'
>;

export const GATEWAY_SERVICE = 'gateway';

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
  geoip?: GeoIp;
  signingKey: () => SigningKey;
  local: Router<LocalContext>;
  localContext: (surface: Surface) => LocalContext;
  upstreamUrl: (service: string) => string;
  forward?: (request: ForwardRequest) => Promise<ForwardResult>;
  now?: () => number;
}

const FLOW_COOKIE_MAX_AGE = 600;

export type GatewayHandler = (request: Request, connection: Connection) => Promise<Response>;

function lookupMethod(method: string): string {
  return method === 'HEAD' ? 'GET' : method;
}

export function createGatewayHandler(options: GatewayHandlerOptions): GatewayHandler {
  const { config, log, metrics, rateLimiter, sessions } = options;
  const now = options.now ?? Date.now;
  const send = options.forward ?? forward;
  const cookieName = sessionCookieName(config.cookies);
  const clearCookie = clearSessionCookie(config.cookies);
  const flowName = flowCookieName(config.cookies);
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
    let setCookie: string | undefined;
    let bindCookie: string | undefined;
    let flowBinding: string | undefined;
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
      if (setCookie !== undefined) headers.append('Set-Cookie', setCookie);
      else if (staleCookie) headers.append('Set-Cookie', clearCookie);
      if (bindCookie !== undefined) headers.append('Set-Cookie', bindCookie);
      if (flowBinding !== undefined) headers.append('Set-Cookie', flowBinding);
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
            if (body === null || !isJsonRequest(request)) return null;
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

    const applySessionHeaders = async (service: string, response: Response): Promise<Response> => {
      const { headers } = response;
      const token = headers.get(SESSION_TOKEN_HEADER);
      const expires = headers.get(SESSION_EXPIRES_HEADER);
      const clear = headers.has(SESSION_CLEAR_HEADER);
      const revoked = headers.get(REVOKED_SESSIONS_HEADER);
      const flow = headers.get(FLOW_BINDING_HEADER);
      for (const name of SESSION_RESPONSE_HEADERS) headers.delete(name);
      if (token === null && !clear && revoked === null && flow === null) return response;
      if (service !== RESOLVE_SESSION_SERVICE) {
        requestLog.warn('ignored session headers from a service other than identity', {
          upstream: service,
        });
        return response;
      }

      const ids = (revoked ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter((id) => id !== '');
      await Promise.all(
        ids.map((id) =>
          sessions.invalidate('session', id).catch((error: unknown) => {
            requestLog.error('session cache invalidation failed', { error });
          }),
        ),
      );

      if (flow !== null) {
        if (isSessionToken(flow)) {
          flowBinding = flowCookie(config.cookies, flow, FLOW_COOKIE_MAX_AGE);
        } else {
          requestLog.error('identity sent an invalid flow binding');
        }
      }

      const expiresAt = expires === null ? Number.NaN : Date.parse(expires);
      if (token !== null && isSessionToken(token) && !Number.isNaN(expiresAt)) {
        setCookie = sessionCookie(
          config.cookies,
          token,
          Math.max(0, Math.floor((expiresAt - now()) / 1000)),
        );
      } else if (token !== null) {
        requestLog.error('identity sent an invalid session token or expiry');
      } else if (clear) {
        setCookie = clearCookie;
      }
      return response;
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

      const { mount: found, params } = lookup.match;
      const entry = found.route;
      const { route } = entry;

      const read = await readBody(request, config.gateway.http.max_body_size);
      if (read.status === 'too_large') return problem('PAYLOAD_TOO_LARGE');
      requestBytes = read.body?.byteLength ?? 0;

      let session: ResolvedSession | null = null;
      const token = readCookie(request.headers.get('cookie'), cookieName);
      const signals = sessionSignals(request, ip, config, options.geoip);
      if (token !== null) {
        const resolved = await sessions.resolve(
          token,
          config.cookies.domain ?? host ?? '',
          config.features.session_security.enabled ? signals : undefined,
        );
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
        if (
          (denial.code === 'AUTHENTICATION_REQUIRED' ||
            denial.code === 'REAUTHENTICATION_REQUIRED') &&
          route.auth === 'session'
        ) {
          const topLevel = isTopLevelNavigation(request);
          const attempted =
            readCookie(request.headers.get('cookie'), bindAttemptCookieName(config.cookies)) !==
            null;
          const account = options.surfaces.find((surface) => surface.name === 'account');
          if (topLevel && account) {
            if (denial.code === 'REAUTHENTICATION_REQUIRED') {
              const login = surfacePublicUrl(account, LOGIN_PATH);
              if (login !== null)
                return new Response(null, { status: 302, headers: { location: login } });
            }
            if (matched.path === BIND_PATH && !needsSessionBinding(config.cookies, host, account)) {
              const returnTo = `${matched.path}${url.search}`;
              const login = surfacePublicUrl(
                account,
                `${LOGIN_PATH}?return_to=${encodeURIComponent(returnTo)}`,
              );
              if (login !== null)
                return new Response(null, { status: 302, headers: { location: login } });
            }
            if (!attempted && needsSessionBinding(config.cookies, host, account)) {
              const location = bindStartUrl(
                account,
                matched.surface.name,
                `${url.pathname}${url.search}`,
              );
              if (location !== null) {
                bindCookie = bindAttemptCookie(config.cookies);
                return new Response(null, { status: 302, headers: { location } });
              }
            }
          }
        }
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
        const input = await parseInput(local, request, params, read.body);
        return toResponse(
          await local.handler({
            ctx: options.localContext(matched.surface),
            identity,
            ...input,
            request,
            request_id: requestId,
            log: requestLog,
          }),
        );
      }

      upstream = entry.service;
      const flow =
        entry.service === RESOLVE_SESSION_SERVICE
          ? readCookie(request.headers.get('cookie'), flowName)
          : null;
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
          ...(flow === null || !isSessionToken(flow) ? {} : { [FLOW_BINDING_HEADER]: flow }),
          'x-forwarded-for': ip,
          ...(host === null ? {} : { 'x-forwarded-host': host }),
          'x-forwarded-proto': matched.surface.origins[0]?.startsWith('http:') ? 'http' : 'https',
          ...(signals.country === null ? {} : { [SESSION_COUNTRY_HEADER]: signals.country }),
          ...(signals.timezone === null ? {} : { [SESSION_TIMEZONE_HEADER]: signals.timezone }),
          ...(signals.screen === null ? {} : { [SESSION_SCREEN_HEADER]: signals.screen }),
          ...(signals.client_fingerprint === null
            ? {}
            : { [SESSION_CLIENT_FINGERPRINT_HEADER]: signals.client_fingerprint }),
          ...(signals.tls_fingerprint === null ||
          config.session_security.tls_fingerprint.header === null
            ? {}
            : { [config.session_security.tls_fingerprint.header]: signals.tls_fingerprint }),
        }),
      });
      if (result.status === 'ok') return applySessionHeaders(entry.service, result.response);
      metrics.upstreamError(entry.service, result.status);
      if (result.status === 'timeout') return problem('UPSTREAM_TIMEOUT');
      requestLog.warn('service unreachable', { upstream: entry.service, error: result.error });
      return problem('SERVICE_UNAVAILABLE');
    };

    const response = await traceHttpRequest(request, routeLabel, async () => {
      try {
        return await handle();
      } catch (error) {
        if (error instanceof ProblemError && error.code in ERRORS) {
          return problem(error.code, {
            ...(error.detail === undefined ? {} : { detail: error.detail }),
            extensions: error.extensions,
            headers: error.headers,
          });
        }
        requestLog.error('request failed', { error });
        return problem('INTERNAL_ERROR');
      }
    });
    return finish(response);
  };
}
