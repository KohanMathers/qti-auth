import {
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { sections } from '@qtiauth/config';

import type { LogDestination } from './logger.ts';
import { startTracing } from './tracing.ts';

export type { ReadableSpan };

export interface CapturedLogs {
  destination: LogDestination;
  lines: string[];
  records: () => Record<string, unknown>[];
  clear: () => void;
}

export interface TestTracing {
  spans: () => ReadableSpan[];
  reset: () => void;
  shutdown: () => Promise<void>;
}

export class LogScrubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LogScrubError';
  }
}

export function captureLogs(): CapturedLogs {
  const lines: string[] = [];
  return {
    destination: {
      write: (line) => {
        lines.push(line);
      },
    },
    lines,
    records: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
    clear: () => {
      lines.length = 0;
    },
  };
}

function mask(secret: string): string {
  return secret.length <= 4
    ? '*'.repeat(secret.length)
    : `${secret.slice(0, 2)}…${secret.slice(-2)}`;
}

export function assertLogsScrubbed(lines: readonly string[], secrets: readonly string[]): void {
  const leaks: string[] = [];
  for (const secret of secrets) {
    if (secret === '') throw new LogScrubError('Secrets to look for must not be empty');
    const forms = new Set([secret, JSON.stringify(secret).slice(1, -1)]);
    lines.forEach((line, index) => {
      if ([...forms].some((form) => line.includes(form))) {
        leaks.push(`line ${String(index + 1)} contains ${mask(secret)}`);
      }
    });
  }
  if (leaks.length > 0) throw new LogScrubError(`Logs leaked secrets:\n${leaks.join('\n')}`);
}

export function startTestTracing(service = 'test'): TestTracing {
  const exporter = new InMemorySpanExporter();
  const tracing = startTracing(sections.observability.parse({}).tracing, service, {
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  return {
    spans: () => exporter.getFinishedSpans(),
    reset: () => {
      exporter.reset();
    },
    shutdown: () => tracing.shutdown(),
  };
}
