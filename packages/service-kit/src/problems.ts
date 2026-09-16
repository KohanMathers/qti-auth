export const PROBLEM_CONTENT_TYPE = 'application/problem+json';
export const PROBLEM_TYPE_PREFIX = 'urn:qtiauth:problem:';

const CODE = /^[A-Z][A-Z0-9_]*$/;

export interface ErrorDefinition {
  status: number;
  title: string;
}

export type ErrorRegistry = Readonly<Record<string, ErrorDefinition>>;

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  request_id?: string;
  [extension: string]: unknown;
}

export interface ProblemOptions {
  detail?: string;
  extensions?: Record<string, unknown>;
  headers?: Record<string, string>;
}

const RESERVED_MEMBERS = new Set(['type', 'title', 'status', 'code', 'detail', 'request_id']);

export class ErrorDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ErrorDefinitionError';
  }
}

export class ProblemError extends Error {
  readonly code: string;
  readonly detail: string | undefined;
  readonly extensions: Record<string, unknown>;
  readonly headers: Record<string, string>;

  constructor(code: string, options: ProblemOptions = {}) {
    super(options.detail ?? code);
    this.name = 'ProblemError';
    this.code = code;
    this.detail = options.detail;
    this.extensions = options.extensions ?? {};
    this.headers = options.headers ?? {};
  }
}

export function defineErrors<const C extends string>(
  errors: Record<C, ErrorDefinition>,
): Readonly<Record<C, ErrorDefinition>> {
  for (const [code, definition] of Object.entries<ErrorDefinition>(errors)) {
    if (!CODE.test(code)) {
      throw new ErrorDefinitionError(`Error code ${code} must be UPPER_SNAKE_CASE`);
    }
    if (
      !Number.isInteger(definition.status) ||
      definition.status < 400 ||
      definition.status > 599
    ) {
      throw new ErrorDefinitionError(`Error code ${code} must have a 4xx or 5xx status`);
    }
    if (definition.title.trim() === '') {
      throw new ErrorDefinitionError(`Error code ${code} needs a title`);
    }
  }
  return Object.freeze({ ...errors });
}

export const KIT_ERRORS = defineErrors({
  VALIDATION_FAILED: { status: 400, title: 'The request is not valid' },
  INVALID_JSON: { status: 400, title: 'The request body is not valid JSON' },
  INVALID_CURSOR: { status: 400, title: 'The pagination cursor is not valid' },
  IDENTITY_TOKEN_INVALID: {
    status: 401,
    title: 'The internal identity token is missing or invalid',
  },
  AUTH_MODE_NOT_ALLOWED: { status: 401, title: 'The route does not accept this kind of caller' },
  PERMISSION_DENIED: { status: 403, title: 'A required permission is missing' },
  INSUFFICIENT_SCOPE: { status: 403, title: 'A required OAuth scope is missing' },
  ACCOUNT_STATE_NOT_ALLOWED: { status: 403, title: 'The account state does not allow this' },
  NOT_FOUND: { status: 404, title: 'No such route' },
  UNSUPPORTED_MEDIA_TYPE: { status: 415, title: 'The request body must be application/json' },
  INTERNAL_ERROR: { status: 500, title: 'Internal error' },
  SERVICE_UNAVAILABLE: { status: 503, title: 'The service is temporarily unavailable' },
});

export type KitErrorCode = keyof typeof KIT_ERRORS;

export function mergeErrors(...registries: ErrorRegistry[]): ErrorRegistry {
  const merged: Record<string, ErrorDefinition> = {};
  for (const registry of registries) {
    for (const [code, definition] of Object.entries(registry)) {
      if (code in merged && merged[code] !== definition) {
        throw new ErrorDefinitionError(`Error code ${code} is defined more than once`);
      }
      merged[code] = definition;
    }
  }
  return Object.freeze(merged);
}

export function problemDetails(
  registry: ErrorRegistry,
  error: ProblemError,
  requestId?: string,
): ProblemDetails {
  const definition = registry[error.code];
  if (!definition) {
    throw new ErrorDefinitionError(`Error code ${error.code} is not registered`);
  }
  const extensions = Object.fromEntries(
    Object.entries(error.extensions).filter(([key]) => !RESERVED_MEMBERS.has(key)),
  );
  return {
    type: `${PROBLEM_TYPE_PREFIX}${error.code}`,
    title: definition.title,
    status: definition.status,
    code: error.code,
    ...(error.detail === undefined ? {} : { detail: error.detail }),
    ...(requestId === undefined ? {} : { request_id: requestId }),
    ...extensions,
  };
}

export function problemResponse(
  problem: ProblemDetails,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(problem), {
    status: problem.status,
    headers: { ...headers, 'content-type': PROBLEM_CONTENT_TYPE, 'cache-control': 'no-store' },
  });
}
