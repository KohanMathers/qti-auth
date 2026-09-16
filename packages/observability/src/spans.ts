import {
  type Attributes,
  type Context,
  context,
  isSpanContextValid,
  propagation,
  ROOT_CONTEXT,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
  TraceFlags,
  type Tracer,
} from '@opentelemetry/api';
import { suppressTracing } from '@opentelemetry/core';

export const TRACER_NAME = '@qtiauth/observability';

export interface TraceIds {
  traceId: string;
  spanId: string;
}

export interface SpanOptions {
  kind?: SpanKind;
  attributes?: Attributes;
  parent?: Context;
}

export type HeaderGetter = (name: string) => string | undefined;
export type HeaderSetter = (name: string, value: string) => void;

export function tracer(): Tracer {
  return trace.getTracer(TRACER_NAME);
}

export function currentTraceIds(): TraceIds | null {
  const spanContext = trace.getSpanContext(context.active());
  if (!spanContext || !isSpanContextValid(spanContext)) return null;
  return { traceId: spanContext.traceId, spanId: spanContext.spanId };
}

export function contextFromTraceIds(traceId: string | null, spanId: string | null): Context {
  if (traceId === null || spanId === null) return ROOT_CONTEXT;
  const spanContext = { traceId, spanId, traceFlags: TraceFlags.NONE, isRemote: true };
  return isSpanContextValid(spanContext)
    ? trace.setSpanContext(ROOT_CONTEXT, spanContext)
    : ROOT_CONTEXT;
}

export function injectTraceContext(set: HeaderSetter, from: Context = context.active()): void {
  propagation.inject(from, undefined, {
    set: (_carrier, name, value) => {
      set(name, value);
    },
  });
}

export function extractTraceContext(get: HeaderGetter, into: Context = context.active()): Context {
  return propagation.extract(into, undefined, {
    get: (_carrier, name) => get(name),
    keys: () => [],
  });
}

export function recordSpanError(span: Span, error: unknown): void {
  span.setAttribute('error.type', error instanceof Error ? error.name : typeof error);
  span.setStatus({ code: SpanStatusCode.ERROR });
}

export function withSpan<T>(
  name: string,
  options: SpanOptions,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer().startActiveSpan(
    name,
    { kind: options.kind ?? SpanKind.INTERNAL, attributes: options.attributes ?? {} },
    options.parent ?? context.active(),
    async (span) => {
      try {
        return await fn(span);
      } catch (error) {
        recordSpanError(span, error);
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

export function untraced<T>(fn: () => T): T {
  return context.with(suppressTracing(context.active()), fn);
}
