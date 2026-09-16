import { randomUUID } from 'node:crypto';

import {
  healthResponse,
  liveness,
  type Logger,
  type Metrics,
  metricsResponse,
  type Readiness,
  traceHttpRequest,
} from '@qtiauth/observability';
import { type Context, Hono } from 'hono';
import type * as z from 'zod';

import {
  type IdentityClaims,
  identityFromClaims,
  IDENTITY_HEADER,
  type IdentityKeySource,
  IdentityTokenError,
  verifyIdentityToken,
} from './identity.ts';
import type { OpenApiDocument } from './openapi.ts';
import { missingPermissions } from './permissions.ts';
import { type ErrorRegistry, problemDetails, ProblemError, problemResponse } from './problems.ts';
import { impliedErrors, type RegisteredRoute, type Router } from './routes.ts';

export const REQUEST_ID_HEADER = 'X-Request-Id';

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const JSON_CONTENT_TYPE = /^application\/(?:[\w.+-]+\+)?json\s*(?:;|$)/i;

export interface HttpMetrics {
  request: (method: string, route: string, status: number, seconds: number) => void;
  identityRejected: (reason: string) => void;
}

export interface HttpAppOptions<Ctx> {
  router: Router<Ctx>;
  context: Ctx;
  log: Logger;
  metrics: Metrics;
  identityKeys: IdentityKeySource;
  clockTolerance: number;
  readiness: () => Promise<Readiness>;
  openapi: () => OpenApiDocument;
}

interface ValidationIssue {
  location: 'params' | 'query' | 'body';
  path: string;
  code: string;
  message: string;
}

export function prometheusHttpMetrics(metrics: Metrics): HttpMetrics {
  const requests = metrics.counter({
    name: 'qtiauth_http_requests_total',
    help: 'Requests handled, by method, route template and status.',
    labelNames: ['method', 'route', 'status'],
  });
  const duration = metrics.histogram({
    name: 'qtiauth_http_request_duration_seconds',
    help: 'Request latency, by method and route template.',
    labelNames: ['method', 'route'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  });
  const rejections = metrics.counter({
    name: 'qtiauth_http_identity_rejections_total',
    help: 'Requests refused because of the internal identity token, by reason.',
    labelNames: ['reason'],
  });
  return {
    request: (method, route, status, seconds) => {
      requests.inc({ method, route, status: String(status) });
      duration.observe({ method, route }, seconds);
    },
    identityRejected: (reason) => {
      rejections.inc({ reason });
    },
  };
}

function requestIdOf(request: Request): string {
  const header = request.headers.get(REQUEST_ID_HEADER);
  return header !== null && REQUEST_ID.test(header) ? header : randomUUID();
}

function issuesOf(location: ValidationIssue['location'], error: z.ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    location,
    path: issue.path.map(String).join('.'),
    code: issue.code,
    message: issue.message,
  }));
}

function queryObject(url: URL): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {};
  for (const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key);
    query[key] = values.length === 1 ? (values[0] ?? '') : values;
  }
  return query;
}

async function readBody(request: Request): Promise<unknown> {
  if (!JSON_CONTENT_TYPE.test(request.headers.get('content-type') ?? '')) {
    throw new ProblemError('UNSUPPORTED_MEDIA_TYPE');
  }
  const text = await request.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new ProblemError('INVALID_JSON');
  }
}

function checkPolicy(
  router: Router<unknown>,
  route: RegisteredRoute<unknown>,
  claims: IdentityClaims,
  log: Logger,
): void {
  if (route.auth === 'none') return;
  if (claims.auth !== route.auth) {
    log.warn('identity token auth mode does not match route', {
      route_auth: route.auth,
      token_auth: claims.auth,
    });
    throw new ProblemError('AUTH_MODE_NOT_ALLOWED');
  }

  const required = route.permissions.flatMap((name) => {
    const permission = router.permissions[name];
    return permission ? [permission] : [];
  });
  const missing = missingPermissions(claims.permissions, required);
  if (missing.length > 0) {
    log.info('missing permissions', { missing_permissions: missing });
    throw new ProblemError('PERMISSION_DENIED');
  }

  const missingScopes = route.scopes.filter((scope) => !claims.scopes.includes(scope));
  if (missingScopes.length > 0) {
    throw new ProblemError('INSUFFICIENT_SCOPE', { extensions: { missing_scopes: missingScopes } });
  }

  const state = claims.account_state;
  if (state !== null) {
    const allowed =
      route.allow_account_states.includes(state) ||
      (state === 'pending_parental_consent' && route.allow_pending_parental_consent);
    if (!allowed) {
      throw new ProblemError('ACCOUNT_STATE_NOT_ALLOWED', { extensions: { account_state: state } });
    }
  }
}

async function parseInput(
  route: RegisteredRoute<unknown>,
  request: Request,
  params: Record<string, string>,
) {
  const issues: ValidationIssue[] = [];
  const parse = (
    location: ValidationIssue['location'],
    schema: z.ZodType | undefined,
    value: unknown,
  ) => {
    if (!schema) return undefined;
    const result = schema.safeParse(value);
    if (result.success) return result.data;
    issues.push(...issuesOf(location, result.error));
    return undefined;
  };

  const input = {
    params: parse('params', route.request.params, params),
    query: parse('query', route.request.query, queryObject(new URL(request.url))),
    body: route.request.body
      ? parse('body', route.request.body, await readBody(request))
      : undefined,
  };
  if (issues.length > 0) {
    throw new ProblemError('VALIDATION_FAILED', { extensions: { errors: issues } });
  }
  return input;
}

function toResponse(result: Awaited<ReturnType<RegisteredRoute<unknown>['handler']>>): Response {
  if (result instanceof Response) return result;
  const headers = new Headers(result.headers);
  if ('body' in result) return Response.json(result.body, { status: result.status, headers });
  return new Response(null, { status: result.status, headers });
}

export function createHttpApp<Ctx>(options: HttpAppOptions<Ctx>): Hono {
  const { router, log } = options;
  const httpMetrics = prometheusHttpMetrics(options.metrics);
  const app = new Hono();

  const problem = (errors: ErrorRegistry, error: ProblemError, requestId: string): Response => {
    const response = problemResponse(problemDetails(errors, error, requestId), error.headers);
    response.headers.set(REQUEST_ID_HEADER, requestId);
    return response;
  };

  const unexpected = (error: unknown, requestLog: Logger, requestId: string): Response => {
    requestLog.error('request failed', { error });
    return problem(router.errors, new ProblemError('INTERNAL_ERROR'), requestId);
  };

  app.get('/healthz', () => healthResponse(liveness(router.service)));
  app.get('/readyz', async () => healthResponse(await options.readiness()));
  app.get('/metrics', () => metricsResponse(options.metrics));
  app.get('/openapi.json', () =>
    Response.json(options.openapi(), { headers: { 'cache-control': 'no-store' } }),
  );

  for (const registered of router.routes) {
    const route = registered as RegisteredRoute<unknown>;
    const declared = new Set<string>([...impliedErrors(route), ...route.errors]);

    const handle = async (c: Context): Promise<Response> => {
      const started = performance.now();
      let requestId = requestIdOf(c.req.raw);
      let requestLog = log.child({ request_id: requestId });

      const response = await traceHttpRequest(c.req.raw, route.path, async () => {
        try {
          let claims: IdentityClaims;
          try {
            claims = await verifyIdentityToken(c.req.header(IDENTITY_HEADER), {
              audience: router.service,
              keys: options.identityKeys,
              clockTolerance: options.clockTolerance,
            });
          } catch (error) {
            if (!(error instanceof IdentityTokenError)) throw error;
            httpMetrics.identityRejected(error.reason);
            requestLog.warn('identity token rejected', { reason: error.reason });
            throw new ProblemError(
              error.reason === 'keys_unavailable'
                ? 'SERVICE_UNAVAILABLE'
                : 'IDENTITY_TOKEN_INVALID',
            );
          }

          requestId = claims.request_id;
          requestLog = log.child({
            request_id: requestId,
            ...(claims.sub === null ? {} : { user_id: claims.sub }),
          });
          checkPolicy(router as Router<unknown>, route, claims, requestLog);
          const input = await parseInput(route, c.req.raw, c.req.param());
          const response = toResponse(
            await route.handler({
              ctx: options.context,
              identity: identityFromClaims(claims),
              ...input,
              request: c.req.raw,
              request_id: requestId,
              log: requestLog,
            }),
          );
          response.headers.set(REQUEST_ID_HEADER, requestId);
          return response;
        } catch (error) {
          if (!(error instanceof ProblemError)) return unexpected(error, requestLog, requestId);
          if (!(error.code in router.errors)) {
            return unexpected(error, requestLog, requestId);
          }
          if (!declared.has(error.code)) {
            requestLog.warn('route returned an error code it does not declare', {
              code: error.code,
            });
          }
          return problem(router.errors, error, requestId);
        }
      });

      httpMetrics.request(
        route.method,
        route.path,
        response.status,
        (performance.now() - started) / 1000,
      );
      return response;
    };

    app.on(route.method, route.path, handle);
  }

  app.notFound((c) =>
    problem(router.errors, new ProblemError('NOT_FOUND'), requestIdOf(c.req.raw)),
  );
  app.onError((error, c) => unexpected(error, log, requestIdOf(c.req.raw)));
  return app;
}
