export const TRUST_LEVELS = ['full', 'partial', 'challenge', 'blocked'] as const;
export type TrustLevel = (typeof TRUST_LEVELS)[number];

export interface TrustSignals {
  ip: string | null;
  subnet: string | null;
  country: string | null;
  userAgent: string | null;
  tlsFingerprint: string | null;
  timezone: string | null;
  screen: string | null;
  clientFingerprint: string | null;
}

const WEIGHTS = {
  ip: 40,
  subnet: 25,
  country: 25,
  userAgent: 20,
  tlsFingerprint: 2,
  timezone: 1,
  screen: 1,
  clientFingerprint: 1,
} as const;

/**
 * Weight that has to be comparable before a mismatch may challenge or end a
 * session. Anything less is only the weak signals (TLS fingerprint, timezone,
 * screen size), which change for ordinary reasons and cannot carry that verdict
 * on their own.
 */
export const CHALLENGE_MIN_WEIGHT = WEIGHTS.country;

export interface TrustVerdict {
  score: number;
  /** Total weight of the signals present on both sides, so comparable at all. */
  comparable: number;
  level: TrustLevel;
}

function same(left: string | null, right: string | null): boolean | null {
  if (left === null || right === null || left === '' || right === '') return null;
  return left === right;
}

function weighted(
  baseline: TrustSignals,
  current: TrustSignals,
): { points: number; comparable: number } {
  let points = 0;
  let comparable = 0;
  const add = (weight: number, match: boolean | null) => {
    if (match === null) return;
    comparable += weight;
    if (match) points += weight;
  };

  const ip = same(baseline.ip, current.ip);
  add(WEIGHTS.ip, ip);
  add(WEIGHTS.subnet, ip === true ? true : same(baseline.subnet, current.subnet));
  add(WEIGHTS.country, same(baseline.country, current.country));
  add(WEIGHTS.userAgent, same(baseline.userAgent, current.userAgent));
  add(WEIGHTS.tlsFingerprint, same(baseline.tlsFingerprint, current.tlsFingerprint));
  add(WEIGHTS.timezone, same(baseline.timezone, current.timezone));
  add(WEIGHTS.screen, same(baseline.screen, current.screen));
  add(WEIGHTS.clientFingerprint, same(baseline.clientFingerprint, current.clientFingerprint));

  return { points, comparable };
}

export function trustScore(baseline: TrustSignals, current: TrustSignals): number {
  const { points, comparable } = weighted(baseline, current);
  if (comparable === 0) return 100;
  return Math.round((points / comparable) * 100);
}

export function trustLevelForScore(
  score: number,
  comparable = Number.POSITIVE_INFINITY,
): TrustLevel {
  if (score >= 85) return 'full';
  if (score >= 55) return 'partial';
  if (comparable < CHALLENGE_MIN_WEIGHT) return 'partial';
  if (score >= 25) return 'challenge';
  return 'blocked';
}

export function trustVerdict(baseline: TrustSignals, current: TrustSignals): TrustVerdict {
  const { points, comparable } = weighted(baseline, current);
  const score = comparable === 0 ? 100 : Math.round((points / comparable) * 100);
  return { score, comparable, level: trustLevelForScore(score, comparable) };
}

export function rank(level: TrustLevel): number {
  return TRUST_LEVELS.indexOf(level);
}

export function worseTrust(left: TrustLevel, right: TrustLevel): TrustLevel {
  return rank(left) >= rank(right) ? left : right;
}
