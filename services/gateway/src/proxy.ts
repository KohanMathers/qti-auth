import type { QtiauthConfig } from '@qtiauth/config';
import { tracedFetch } from '@qtiauth/observability';

export const FORWARDED_REQUEST_HEADERS = [
  'accept',
  'accept-language',
  'content-type',
  'if-match',
  'if-modified-since',
  'if-none-match',
  'if-unmodified-since',
  'idempotency-key',
  'origin',
  'user-agent',
] as const;

const HOP_BY_HOP = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

export type ForwardResult =
  | { status: 'ok'; response: Response }
  | { status: 'timeout' }
  | { status: 'unreachable'; error: unknown };

export interface ForwardRequest {
  url: string;
  method: string;
  headers: Headers;
  body: Uint8Array | null;
  timeout: number;
}

export type BodyResult = { status: 'ok'; body: Uint8Array | null } | { status: 'too_large' };

export function upstreamUrl(
  config: Pick<QtiauthConfig, 'gateway' | 'service'>,
  service: string,
): string {
  const base =
    config.gateway.upstreams[service] ?? `http://${service}:${String(config.service.http.port)}`;
  return base.replace(/\/+$/, '');
}

export function upstreamHeaders(request: Request, extra: Record<string, string>): Headers {
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  headers.set('accept-encoding', 'identity');
  for (const [name, value] of Object.entries(extra)) headers.set(name, value);
  return headers;
}

export async function readBody(request: Request, maxBytes: number): Promise<BodyResult> {
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > maxBytes) return { status: 'too_large' };
  if (!request.body) return { status: 'ok', body: null };

  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = (request.body as ReadableStream<Uint8Array>).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return { status: 'too_large' };
    }
    chunks.push(value);
  }
  if (size === 0) return { status: 'ok', body: null };
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { status: 'ok', body };
}

function isTimeout(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'TimeoutError';
}

export async function forward(request: ForwardRequest): Promise<ForwardResult> {
  let upstream: Response;
  try {
    upstream = await tracedFetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: 'manual',
      signal: AbortSignal.timeout(request.timeout),
    });
  } catch (error) {
    if (isTimeout(error)) return { status: 'timeout' };
    return { status: 'unreachable', error };
  }
  const headers = new Headers(upstream.headers);
  for (const name of HOP_BY_HOP) headers.delete(name);
  return {
    status: 'ok',
    response: new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    }),
  };
}
