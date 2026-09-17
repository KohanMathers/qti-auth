import type { QtiauthConfig } from '@qtiauth/config';

import type { Surface } from './surfaces.ts';

export const CORS_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export const CORS_REQUEST_HEADERS = ['Content-Type', 'Authorization', 'X-Request-Id'] as const;
export const CORS_EXPOSED_HEADERS = [
  'RateLimit-Limit',
  'RateLimit-Remaining',
  'RateLimit-Reset',
  'RateLimit-Policy',
  'Retry-After',
  'X-Request-Id',
] as const;
export const CORS_MAX_AGE = 600;

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function allowedOrigins(
  config: Pick<QtiauthConfig, 'cors'>,
  surfaces: readonly Surface[],
): ReadonlySet<string> {
  return new Set([
    ...surfaces.flatMap((surface) => surface.origins),
    ...config.cors.allowed_origins,
  ]);
}

export function isStateChanging(method: string): boolean {
  return !SAFE_METHODS.has(method.toUpperCase());
}

export function isPreflight(request: Request): boolean {
  return (
    request.method === 'OPTIONS' &&
    request.headers.has('origin') &&
    request.headers.has('access-control-request-method')
  );
}

export function applyCors(headers: Headers, origin: string | null, allowed: ReadonlySet<string>) {
  headers.append('Vary', 'Origin');
  if (origin === null || !allowed.has(origin)) return;
  headers.set('Access-Control-Allow-Origin', origin);
  headers.set('Access-Control-Allow-Credentials', 'true');
  headers.set('Access-Control-Expose-Headers', CORS_EXPOSED_HEADERS.join(', '));
}

export function preflightResponse(request: Request, allowed: ReadonlySet<string>): Response {
  const headers = new Headers({ 'cache-control': 'no-store' });
  const origin = request.headers.get('origin');
  headers.append('Vary', 'Origin');
  headers.append('Vary', 'Access-Control-Request-Method');
  headers.append('Vary', 'Access-Control-Request-Headers');
  if (origin !== null && allowed.has(origin)) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Credentials', 'true');
    headers.set('Access-Control-Allow-Methods', CORS_METHODS.join(', '));
    headers.set('Access-Control-Allow-Headers', CORS_REQUEST_HEADERS.join(', '));
    headers.set('Access-Control-Max-Age', String(CORS_MAX_AGE));
  }
  return new Response(null, { status: 204, headers });
}
