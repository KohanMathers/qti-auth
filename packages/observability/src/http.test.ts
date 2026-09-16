import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { traceHttpRequest, tracedFetch } from './http.ts';
import { startTestTracing, type TestTracing } from './testing.ts';

let tracing: TestTracing;
let server: Server;
let received: string | undefined;
let origin: string;

beforeAll(async () => {
  tracing = startTestTracing();
  server = createServer((req, res) => {
    received = req.headers['traceparent']?.toString();
    res.writeHead(req.url === '/fail' ? 502 : 200).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

beforeEach(() => {
  tracing.reset();
  received = undefined;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await tracing.shutdown();
});

describe('traceHttpRequest', () => {
  it('continues the caller trace and names the span after the route', async () => {
    const traceparent = `00-${'1'.repeat(32)}-${'2'.repeat(16)}-01`;
    const request = new Request('https://api.example.com/api/v1/users/u1?token=secret', {
      method: 'post',
      headers: { traceparent },
    });
    const response = await traceHttpRequest(request, '/api/v1/users/:id', () =>
      Promise.resolve(new Response(null, { status: 503 })),
    );

    expect(response.status).toBe(503);
    const [span] = tracing.spans();
    expect(span?.name).toBe('POST /api/v1/users/:id');
    expect(span?.kind).toBe(SpanKind.SERVER);
    expect(span?.spanContext().traceId).toBe('1'.repeat(32));
    expect(span?.parentSpanContext?.spanId).toBe('2'.repeat(16));
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.attributes).toMatchObject({
      'http.request.method': 'POST',
      'http.route': '/api/v1/users/:id',
      'http.response.status_code': 503,
    });
    expect(JSON.stringify(span?.attributes)).not.toContain('secret');
  });
});

describe('tracedFetch', () => {
  it('sends the trace context and records the status', async () => {
    const response = await tracedFetch(`${origin}/fail`, { method: 'post' });

    expect(response.status).toBe(502);
    const [span] = tracing.spans();
    expect(span?.kind).toBe(SpanKind.CLIENT);
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(received).toBe(
      `00-${String(span?.spanContext().traceId)}-${String(span?.spanContext().spanId)}-01`,
    );
  });
});
