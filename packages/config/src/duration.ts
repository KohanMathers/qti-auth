import * as z from 'zod';

const UNIT_MS = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
} as const;

const DURATION_PATTERN = /^(\d+)(ms|s|m|h|d|w)$/;

function durationDescription(description: string): string {
  return `${description} Written as <integer><unit> (ms, s, m, h, d, w).`;
}

export function parseDuration(value: string): number | undefined {
  const match = DURATION_PATTERN.exec(value);
  if (!match) return undefined;
  const [, amount, unit] = match as unknown as [string, string, keyof typeof UNIT_MS];
  const ms = Number(amount) * UNIT_MS[unit];
  return ms > 0 && Number.isSafeInteger(ms) ? ms : undefined;
}

export function requiredDuration(description: string) {
  return z
    .string()
    .regex(DURATION_PATTERN, 'Must be a duration like 30s, 15m, 12h or 7d')
    .transform((value, ctx) => {
      const match = DURATION_PATTERN.exec(value);
      if (!match) return z.NEVER;
      const [, amount, unit] = match as unknown as [string, string, keyof typeof UNIT_MS];
      const ms = Number(amount) * UNIT_MS[unit];
      if (ms <= 0) {
        ctx.issues.push({ code: 'custom', message: 'Duration must be positive', input: value });
        return z.NEVER;
      }
      if (!Number.isSafeInteger(ms)) {
        ctx.issues.push({ code: 'custom', message: 'Duration is too large', input: value });
        return z.NEVER;
      }
      return ms;
    })
    .describe(durationDescription(description));
}

export function duration(defaultValue: string, description: string) {
  return requiredDuration(description).prefault(defaultValue);
}
