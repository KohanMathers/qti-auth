import { MODULES } from '@qtiauth/config';
import type { Logger } from '@qtiauth/observability';
import * as z from 'zod';

import {
  ACCOUNT_STATES,
  type AccountState,
  AUTH_MODES,
  type AuthMode,
  type Identity,
} from './identity.ts';
import type { PermissionRegistry } from './permissions.ts';
import { type ErrorRegistry, KIT_ERRORS, type KitErrorCode, mergeErrors } from './problems.ts';

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export const ROUTE_MODULES = ['core', ...MODULES] as const;
export type RouteModule = (typeof ROUTE_MODULES)[number];

export const INTERNAL_PATHS = ['/healthz', '/readyz', '/metrics', '/openapi.json'] as const;

const PATH = /^(?:\/(?:[A-Za-z0-9._~-]+|:[a-z][a-z0-9_]*))+$|^\/$/;
const PATH_PARAM = /:([a-z][a-z0-9_]*)/g;
const OPERATION_ID = /^[a-z][A-Za-z0-9]*$/;
const RATE_LIMIT = /^[a-z][a-z0-9_]*$/;
const SCOPE = /^[\x21\x23-\x5b\x5d-\x7e]+$/;

type ObjectSchema = z.ZodObject;
type Parsed<S> = S extends z.ZodType ? z.output<S> : undefined;

export interface ResponseDefinition {
  description: string;
  schema?: z.ZodType;
}

export type ResponseMap = Readonly<Record<number, ResponseDefinition>>;

export type HandlerResult<R extends ResponseMap> = [R] extends [never]
  ? never
  : | Response
    | {
        [S in keyof R & number]: R[S]['schema'] extends z.ZodType
          ? { status: S; body: z.input<R[S]['schema']>; headers?: Record<string, string> }
          : { status: S; headers?: Record<string, string> };
      }[keyof R & number];

export interface HandlerInput<Ctx, P, Q, B> {
  ctx: Ctx;
  identity: Identity;
  params: Parsed<P>;
  query: Parsed<Q>;
  body: Parsed<B>;
  request: Request;
  request_id: string;
  log: Logger;
}

export interface RoutePolicy {
  auth: AuthMode;
  permissions: readonly string[];
  scopes: readonly string[];
  allow_account_states: readonly AccountState[];
  allow_pending_legal: boolean;
  allow_pending_parental_consent: boolean;
  allow_pending_2fa_enrolment: boolean;
  allow_aal0: boolean;
  rate_limit: string;
  step_up: boolean;
}

export interface RouteDefinition<
  Ctx,
  P extends ObjectSchema | undefined,
  Q extends ObjectSchema | undefined,
  B extends z.ZodType | undefined,
  R extends ResponseMap,
> {
  method: HttpMethod;
  path: string;
  operation_id: string;
  summary: string;
  description?: string;
  tags?: readonly string[];
  module?: RouteModule;
  auth: AuthMode;
  permissions?: readonly string[];
  scopes?: readonly string[];
  allow_account_states?: readonly AccountState[];
  allow_pending_legal?: boolean;
  allow_pending_parental_consent?: boolean;
  allow_pending_2fa_enrolment?: boolean;
  allow_aal0?: boolean;
  rate_limit: string;
  step_up?: boolean;
  request?: { params?: P; query?: Q; body?: B };
  responses: R;
  errors?: readonly string[];
  handler: (
    input: HandlerInput<Ctx, NoInfer<P>, NoInfer<Q>, NoInfer<B>>,
  ) => Promise<HandlerResult<NoInfer<R>>>;
}

export interface RouteInfo extends RoutePolicy {
  method: HttpMethod;
  path: string;
  operation_id: string;
  summary: string;
  description: string | undefined;
  tags: readonly string[];
  module: RouteModule;
  request: {
    params?: ObjectSchema | undefined;
    query?: ObjectSchema | undefined;
    body?: z.ZodType | undefined;
  };
  responses: ResponseMap;
  errors: readonly string[];
}

export interface RegisteredRoute<Ctx> extends RouteInfo {
  handler: (
    input: HandlerInput<Ctx, z.ZodType, z.ZodType, z.ZodType>,
  ) => Promise<HandlerResult<ResponseMap>>;
}

export const manifestRouteSchema = z.strictObject({
  method: z.enum(HTTP_METHODS),
  path: z.string().regex(PATH),
  module: z.enum(ROUTE_MODULES),
  auth: z.enum(AUTH_MODES),
  permissions: z.array(z.string()),
  scopes: z.array(z.string()),
  allow_account_states: z.array(z.enum(ACCOUNT_STATES)),
  allow_pending_legal: z.boolean(),
  allow_pending_parental_consent: z.boolean(),
  allow_pending_2fa_enrolment: z.boolean(),
  allow_aal0: z.boolean(),
  rate_limit: z.string().regex(RATE_LIMIT),
  step_up: z.boolean(),
});

export const routeManifestSchema = z.strictObject({
  service: z.string().min(1),
  version: z.string().min(1),
  routes: z.array(manifestRouteSchema),
  permissions: z.array(
    z.strictObject({ name: z.string(), description: z.string(), wildcard: z.boolean() }),
  ),
});

export type ManifestRoute = z.output<typeof manifestRouteSchema>;
export type RouteManifest = z.output<typeof routeManifestSchema>;

export interface RouterOptions {
  service: string;
  version: string;
  module: RouteModule;
  permissions?: PermissionRegistry;
  errors?: ErrorRegistry;
}

export interface Router<Ctx> {
  service: string;
  version: string;
  module: RouteModule;
  permissions: PermissionRegistry;
  errors: ErrorRegistry;
  routes: readonly RegisteredRoute<Ctx>[];
  route: <
    P extends ObjectSchema | undefined = undefined,
    Q extends ObjectSchema | undefined = undefined,
    B extends z.ZodType | undefined = undefined,
    const R extends ResponseMap = ResponseMap,
  >(
    definition: RouteDefinition<Ctx, P, Q, B, R>,
  ) => void;
  manifest: () => RouteManifest;
}

export class RouteDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RouteDefinitionError';
  }
}

export function pathParams(path: string): string[] {
  return [...path.matchAll(PATH_PARAM)].map((match) => match[1] ?? '');
}

export function impliedErrors(route: RouteInfo): KitErrorCode[] {
  const codes: KitErrorCode[] = ['IDENTITY_TOKEN_INVALID', 'INTERNAL_ERROR', 'SERVICE_UNAVAILABLE'];
  if (route.auth !== 'none') codes.push('AUTH_MODE_NOT_ALLOWED', 'ACCOUNT_STATE_NOT_ALLOWED');
  if (route.permissions.length > 0) codes.push('PERMISSION_DENIED');
  if (route.scopes.length > 0) codes.push('INSUFFICIENT_SCOPE');
  const { params, query, body } = route.request;
  if (params !== undefined || query !== undefined || body !== undefined) {
    codes.push('VALIDATION_FAILED');
  }
  if (body) codes.push('INVALID_JSON', 'UNSUPPORTED_MEDIA_TYPE');
  return codes;
}

export function manifestRoute(route: RouteInfo): ManifestRoute {
  return {
    method: route.method,
    path: route.path,
    module: route.module,
    auth: route.auth,
    permissions: [...route.permissions],
    scopes: [...route.scopes],
    allow_account_states: [...route.allow_account_states],
    allow_pending_legal: route.allow_pending_legal,
    allow_pending_parental_consent: route.allow_pending_parental_consent,
    allow_pending_2fa_enrolment: route.allow_pending_2fa_enrolment,
    allow_aal0: route.allow_aal0,
    rate_limit: route.rate_limit,
    step_up: route.step_up,
  };
}

function check(condition: boolean, route: string, message: string): void {
  if (!condition) throw new RouteDefinitionError(`${route}: ${message}`);
}

function validate(
  existing: readonly RouteInfo[],
  options: Required<RouterOptions>,
  route: RouteInfo,
): void {
  const name = `${route.method} ${route.path}`;
  const { request } = route;

  check((HTTP_METHODS as readonly string[]).includes(route.method), name, 'Unknown method');
  check(PATH.test(route.path), name, 'Path must be /segments with :lowercase_params');
  check(
    !(INTERNAL_PATHS as readonly string[]).includes(route.path),
    name,
    'Path is reserved for internal endpoints',
  );
  check(
    !existing.some((r) => r.method === route.method && r.path === route.path),
    name,
    'Route is defined more than once',
  );
  check(OPERATION_ID.test(route.operation_id), name, 'operation_id must be camelCase');
  check(
    !existing.some((r) => r.operation_id === route.operation_id),
    name,
    `operation_id ${route.operation_id} is used more than once`,
  );
  check(route.summary.trim() !== '', name, 'summary is required');
  check((ROUTE_MODULES as readonly string[]).includes(route.module), name, 'Unknown module');
  check((AUTH_MODES as readonly string[]).includes(route.auth), name, 'Unknown auth mode');
  check(RATE_LIMIT.test(route.rate_limit), name, 'rate_limit must name a policy');

  const params = pathParams(route.path);
  const paramKeys = Object.keys(request.params?.shape ?? {});
  check(
    params.length === paramKeys.length && params.every((param) => paramKeys.includes(param)),
    name,
    `request.params must describe exactly the path parameters (${params.join(', ') || 'none'})`,
  );
  check(
    request.body === undefined || !['GET', 'DELETE'].includes(route.method),
    name,
    `${route.method} routes can't have a body`,
  );

  for (const permission of route.permissions) {
    check(permission in options.permissions, name, `Permission ${permission} is not declared`);
  }
  check(
    route.auth !== 'none' || route.permissions.length === 0,
    name,
    'Routes with auth: none cannot require permissions',
  );

  for (const scope of route.scopes) check(SCOPE.test(scope), name, `Invalid scope ${scope}`);
  check(
    route.scopes.length === 0 || ['oauth', 'service', 'game_authoritative'].includes(route.auth),
    name,
    'Scopes need auth: oauth, service or game_authoritative',
  );
  check(!route.step_up || route.auth === 'session', name, 'step_up needs auth: session');
  check(!route.allow_aal0 || route.auth === 'session', name, 'allow_aal0 needs auth: session');

  check(route.allow_account_states.length > 0, name, 'allow_account_states must not be empty');
  for (const state of route.allow_account_states) {
    check(
      (ACCOUNT_STATES as readonly string[]).includes(state),
      name,
      `Unknown account state ${state}`,
    );
  }

  const statuses = Object.keys(route.responses).map(Number);
  check(statuses.length > 0, name, 'At least one response is required');
  for (const status of statuses) {
    check(
      Number.isInteger(status) && status >= 200 && status <= 399,
      name,
      `Response ${String(status)} must be 2xx or 3xx. Errors come from the error registry`,
    );
  }
  for (const code of route.errors) {
    check(code in options.errors, name, `Error code ${code} is not registered`);
  }
}

export function createRouter<Ctx>(options: RouterOptions): Router<Ctx> {
  check(
    (ROUTE_MODULES as readonly string[]).includes(options.module),
    options.service,
    'Unknown module',
  );
  const resolved: Required<RouterOptions> = {
    ...options,
    permissions: options.permissions ?? {},
    errors: mergeErrors(KIT_ERRORS, options.errors ?? {}),
  };
  const routes: RegisteredRoute<Ctx>[] = [];

  return {
    service: resolved.service,
    version: resolved.version,
    module: resolved.module,
    permissions: resolved.permissions,
    errors: resolved.errors,
    routes,
    route: (definition) => {
      const route: RegisteredRoute<Ctx> = {
        method: definition.method,
        path: definition.path,
        operation_id: definition.operation_id,
        summary: definition.summary,
        description: definition.description,
        tags: definition.tags ?? [],
        module: definition.module ?? resolved.module,
        auth: definition.auth,
        permissions: definition.permissions ?? [],
        scopes: definition.scopes ?? [],
        allow_account_states: definition.allow_account_states ?? ['active'],
        allow_pending_legal: definition.allow_pending_legal ?? false,
        allow_pending_parental_consent: definition.allow_pending_parental_consent ?? false,
        allow_pending_2fa_enrolment: definition.allow_pending_2fa_enrolment ?? false,
        allow_aal0: definition.allow_aal0 ?? false,
        rate_limit: definition.rate_limit,
        step_up: definition.step_up ?? false,
        request: definition.request ?? {},
        responses: definition.responses,
        errors: definition.errors ?? [],
        handler: definition.handler as RegisteredRoute<Ctx>['handler'],
      };
      validate(routes, resolved, route);
      routes.push(route);
    },
    manifest: () => ({
      service: resolved.service,
      version: resolved.version,
      routes: routes.map((route) => manifestRoute(route)),
      permissions: Object.values(resolved.permissions).map((permission) => ({ ...permission })),
    }),
  };
}
