export const REDACTED = '[REDACTED]';

export const REDACTED_KEYS = [
  'password',
  'passphrase',
  'secret',
  'token',
  'tokens',
  'authorization',
  'cookie',
  'apikey',
  'privatekey',
  'credentials',
  'otp',
  'totpcode',
  'recoverycode',
  'recoverycodes',
  'steamticket',
  'reportcontent',
  'emailbody',
  'filterinput',
  'signature',
  'captcha',
] as const;

const MAX_DEPTH = 10;

export type Redactor = (value: unknown) => unknown;

export function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function isRedactedKey(key: string, keys: readonly string[] = REDACTED_KEYS): boolean {
  const normalized = normalizeKey(key);
  return keys.some((entry) => normalized.endsWith(entry));
}

function errorFields(error: Error): Record<string, unknown> {
  return {
    type: error.name,
    message: error.message,
    ...(error.stack === undefined ? {} : { stack: error.stack }),
    ...Object.fromEntries(Object.entries(error)),
    ...(error.cause === undefined ? {} : { cause: error.cause }),
  };
}

export function createRedactor(extraKeys: readonly string[] = []): Redactor {
  const keys = [...REDACTED_KEYS, ...extraKeys.map(normalizeKey)];
  const seen = new WeakSet<object>();

  const visit = (value: unknown, depth: number): unknown => {
    if (typeof value === 'bigint') return value.toString();
    if (typeof value !== 'object' || value === null) return value;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return '[Binary]';
    if (depth >= MAX_DEPTH) return '[Truncated]';
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    try {
      if (Array.isArray(value)) return value.map((item) => visit(item, depth + 1));
      const source = value instanceof Error ? errorFields(value) : value;
      const entries = source instanceof Map ? [...source.entries()] : Object.entries(source);
      return Object.fromEntries(
        entries.map(([key, item]) => [
          String(key),
          isRedactedKey(String(key), keys) ? REDACTED : visit(item, depth + 1),
        ]),
      );
    } finally {
      seen.delete(value);
    }
  };

  return (value) => visit(value, 0);
}
