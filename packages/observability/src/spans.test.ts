import { context, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  contextFromTraceIds,
  currentTraceIds,
  extractTraceContext,
  injectTraceContext,
  untraced,
  withSpan,
} from './spans.ts';
import { startTestTracing, type TestTracing } from './testing.ts';

let tracing: TestTracing;

beforeAll(() => {
  tracing = startTestTracing();
});

beforeEach(() => {
  tracing.reset();
});

afterAll(async () => {
  await tracing.shutdown();
});

describe('withSpan', () => {
  it('nests spans and records errors by type only', async () => {
    await expect(
      withSpan('outer', { kind: SpanKind.SERVER }, () =>
        withSpan('inner', {}, () => Promise.reject(new TypeError('token abc was invalid'))),
      ),
    ).rejects.toThrow(TypeError);

    const [inner, outer] = tracing.spans();
    expect(inner?.parentSpanContext?.spanId).toBe(outer?.spanContext().spanId);
    expect(outer?.kind).toBe(SpanKind.SERVER);
    expect(inner?.status.code).toBe(SpanStatusCode.ERROR);
    expect(inner?.attributes['error.type']).toBe('TypeError');
    expect(JSON.stringify(inner?.events)).not.toContain('token abc');
  });

  it('records nothing inside untraced', async () => {
    await untraced(() => withSpan('quiet', {}, () => Promise.resolve()));
    expect(tracing.spans()).toEqual([]);
  });
});

describe('trace context', () => {
  it('round-trips through headers', async () => {
    const headers = new Map<string, string>();
    const sent = await withSpan('publish', {}, (span) => {
      injectTraceContext((name, value) => headers.set(name, value));
      return Promise.resolve(span.spanContext());
    });
    expect(headers.get('traceparent')).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);

    const received = trace.getSpanContext(extractTraceContext((name) => headers.get(name)));
    expect(received).toMatchObject({ traceId: sent.traceId, spanId: sent.spanId, isRemote: true });
  });

  it('rebuilds a parent from stored IDs', async () => {
    const traceId = 'a'.repeat(32);
    const spanId = 'b'.repeat(16);
    await withSpan('consume', { parent: contextFromTraceIds(traceId, spanId) }, () => {
      expect(currentTraceIds()).toMatchObject({ traceId });
      return Promise.resolve();
    });
    expect(tracing.spans()[0]?.parentSpanContext?.spanId).toBe(spanId);

    expect(trace.getSpanContext(contextFromTraceIds(null, spanId))).toBeUndefined();
    expect(trace.getSpanContext(contextFromTraceIds('0'.repeat(32), spanId))).toBeUndefined();
  });

  it('has no IDs outside a span', () => {
    expect(context.with(context.active(), currentTraceIds)).toBeNull();
  });
});
