import type { QtiauthConfig } from '@qtiauth/config';

const SAFE_METHODS = new Set(['GET', 'HEAD']);

export class GatewayError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'GatewayError';
    this.status = status;
  }
}

export interface GatewayContext {
  request: Request;
  config: Pick<QtiauthConfig, 'cookies'>;
  baseUrl?: string;
}

export interface GatewayFetchOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

function cookieNameFor(config: Pick<QtiauthConfig, 'cookies'>): string {
  const base = config.cookies.name;
  return config.cookies.domain === null ? `__Host-${base}` : base;
}

function baseUrlFor(ctx: GatewayContext): string {
  if (ctx.baseUrl !== undefined) return ctx.baseUrl;
  const fromEnv = process.env['GATEWAY_URL'] ?? process.env['QTIAUTH_GATEWAY_URL'];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv.replace(/\/$/, '');
  return 'http://gateway:8000';
}

function forwardCookieHeader(ctx: GatewayContext): string | undefined {
  const header = ctx.request.headers.get('cookie');
  if (header === null || header === '') return undefined;
  const name = cookieNameFor(ctx.config);
  const pattern = new RegExp(`(?:^|;\\s*)${name.replaceAll(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}=([^;]+)`);
  const match = pattern.exec(header);
  return match === null ? undefined : `${name}=${match[1] ?? ''}`;
}

export async function gatewayFetch(
  ctx: GatewayContext,
  path: string,
  options: GatewayFetchOptions = {},
): Promise<Response> {
  const method = options.method ?? 'GET';
  const url = `${baseUrlFor(ctx)}${path.startsWith('/') ? path : `/${path}`}`;
  const headers: Record<string, string> = {
    accept: 'application/json',
    ...options.headers,
  };
  const cookie = forwardCookieHeader(ctx);
  if (cookie !== undefined) headers['cookie'] = cookie;
  const forwarded = ctx.request.headers.get('x-forwarded-for');
  if (forwarded !== null) headers['x-forwarded-for'] = forwarded;
  const init: RequestInit = { method, headers };
  if (options.body !== undefined && !SAFE_METHODS.has(method)) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }
  return fetch(url, init);
}

export async function gatewayGet<T = unknown>(
  ctx: GatewayContext,
  path: string,
): Promise<T | null> {
  const response = await gatewayFetch(ctx, path);
  if (response.status === 401 || response.status === 403 || response.status === 404) return null;
  if (response.status >= 500) {
    throw new GatewayError(`Gateway returned ${String(response.status)} for ${path}`, response.status);
  }
  if (response.status === 204) return null;
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) return null;
  return (await response.json()) as T;
}

export interface GatewayClient {
  get: <T = unknown>(path: string) => Promise<T | null>;
  fetch: (path: string, options?: GatewayFetchOptions) => Promise<Response>;
}

export function gatewayClient(ctx: GatewayContext): GatewayClient {
  return {
    get: (path) => gatewayGet(ctx, path),
    fetch: (path, options) => gatewayFetch(ctx, path, options),
  };
}
