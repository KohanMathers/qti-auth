import { createHmac } from 'node:crypto';

import type { QtiauthConfig } from '@qtiauth/config';

import { createRedactor } from './redact.ts';
import { currentTraceIds } from './spans.ts';

export type LogsConfig = QtiauthConfig['observability']['logs'];
export type LogLevel = LogsConfig['level'];
export type LogFields = Record<string, unknown>;

export const LEVEL_SEVERITY: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

const RESERVED_FIELDS = new Set(['time', 'level', 'service', 'message', 'trace_id', 'span_id']);

export interface LogDestination {
  write: (line: string) => void;
}

export interface LoggerOptions {
  service: string;
  config: LogsConfig;
  destination?: LogDestination;
}

export interface Logger {
  trace: (message: string, fields?: LogFields) => void;
  debug: (message: string, fields?: LogFields) => void;
  info: (message: string, fields?: LogFields) => void;
  warn: (message: string, fields?: LogFields) => void;
  error: (message: string, fields?: LogFields) => void;
  fatal: (message: string, fields?: LogFields) => void;
  child: (fields: LogFields) => Logger;
  isLevelEnabled: (level: LogLevel) => boolean;
}

export function hashUserId(key: string, userId: string): string {
  return createHmac('sha256', key).update(userId).digest('hex').slice(0, 32);
}

const stdout: LogDestination = {
  write: (line) => {
    process.stdout.write(line);
  },
};

export function createLogger(options: LoggerOptions): Logger {
  const { config, service } = options;
  const destination = options.destination ?? stdout;
  const redact = createRedactor(config.redact_keys);
  const minimum = LEVEL_SEVERITY[config.level];

  const write = (level: LogLevel, message: string, bindings: LogFields, fields: LogFields) => {
    const record: LogFields = { time: new Date().toISOString(), level, service, message };
    const ids = currentTraceIds();
    if (ids) {
      record['trace_id'] = ids.traceId;
      record['span_id'] = ids.spanId;
    }
    const extra = redact({ ...bindings, ...fields }) as LogFields;
    for (const [key, value] of Object.entries(extra)) {
      if (RESERVED_FIELDS.has(key)) continue;
      record[key] =
        key === 'user_id' && typeof value === 'string'
          ? hashUserId(config.user_id_hash_key, value)
          : value;
    }
    destination.write(`${JSON.stringify(record)}\n`);
  };

  const build = (bindings: LogFields): Logger => {
    const at =
      (level: LogLevel) =>
      (message: string, fields: LogFields = {}) => {
        if (LEVEL_SEVERITY[level] >= minimum) write(level, message, bindings, fields);
      };
    return {
      trace: at('trace'),
      debug: at('debug'),
      info: at('info'),
      warn: at('warn'),
      error: at('error'),
      fatal: at('fatal'),
      child: (fields) => build({ ...bindings, ...fields }),
      isLevelEnabled: (level) => LEVEL_SEVERITY[level] >= minimum,
    };
  };

  return build({});
}
