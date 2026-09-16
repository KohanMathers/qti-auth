import { SpanKind, SpanStatusCode } from '@opentelemetry/api';

import { extractTraceContext, injectTraceContext, withSpan } from './spans.ts';

export function traceHttpRequest(
  request: Request,
  route: string,
  handler: () => Promise<Response>,
): Promise<Response> {
  const method = request.method.toUpperCase();
  const parent = extractTraceContext((name) => request.headers.get(name) ?? undefined);
  return withSpan(
    `${method} ${route}`,
    {
      kind: SpanKind.SERVER,
      parent,
      attributes: {
        'http.request.method': method,
        'http.route': route,
        'url.scheme': new URL(request.url).protocol.replace(/:$/, ''),
      },
    },
    async (span) => {
      const response = await handler();
      span.setAttribute('http.response.status_code', response.status);
      if (response.status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      return response;
    },
  );
}

export function tracedFetch(url: string | URL, init: RequestInit = {}): Promise<Response> {
  const target = new URL(url);
  const method = (init.method ?? 'GET').toUpperCase();
  return withSpan(
    method,
    {
      kind: SpanKind.CLIENT,
      attributes: {
        'http.request.method': method,
        'server.address': target.hostname,
        ...(target.port === '' ? {} : { 'server.port': Number(target.port) }),
      },
    },
    async (span) => {
      const headers = new Headers(init.headers);
      injectTraceContext((name, value) => {
        headers.set(name, value);
      });
      const response = await fetch(target, { ...init, headers });
      span.setAttribute('http.response.status_code', response.status);
      if (response.status >= 400) span.setStatus({ code: SpanStatusCode.ERROR });
      return response;
    },
  );
}
