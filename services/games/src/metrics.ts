import type { EntitlementSource } from '@qtiauth/config';
import type { Metrics } from '@qtiauth/observability';

export const KEY_REDEMPTION_OUTCOMES = [
  'redeemed',
  'invalid',
  'expired',
  'revoked',
  'already_redeemed',
  'already_owned',
] as const;
export type KeyRedemptionOutcome = (typeof KEY_REDEMPTION_OUTCOMES)[number];

export const CAPTCHA_RESULTS = ['shown', 'solved', 'failed'] as const;
export type CaptchaResult = (typeof CAPTCHA_RESULTS)[number];

export interface GamesMetrics {
  granted: (source: EntitlementSource) => void;
  revoked: (source: EntitlementSource) => void;
  keyRedeemed: (outcome: KeyRedemptionOutcome) => void;
  keysGenerated: (count: number) => void;
  captcha: (result: CaptchaResult) => void;
}

const created = new WeakMap<Metrics, GamesMetrics>();

export function gamesMetrics(metrics: Metrics): GamesMetrics {
  let games = created.get(metrics);
  if (!games) {
    games = prometheusGamesMetrics(metrics);
    created.set(metrics, games);
  }
  return games;
}

function prometheusGamesMetrics(metrics: Metrics): GamesMetrics {
  const grants = metrics.counter({
    name: 'qtiauth_games_entitlements_granted_total',
    help: 'Entitlements granted, by source.',
    labelNames: ['source'],
  });
  const revokes = metrics.counter({
    name: 'qtiauth_games_entitlements_revoked_total',
    help: 'Entitlements revoked, by source. Expiry counts as a revoke.',
    labelNames: ['source'],
  });
  const keyRedemptions = metrics.counter({
    name: 'qtiauth_games_key_redemptions_total',
    help: 'Key redemption attempts, by outcome.',
    labelNames: ['outcome'],
  });
  const keysGenerated = metrics.counter({
    name: 'qtiauth_games_keys_generated_total',
    help: 'Keys generated across every batch.',
  });
  const captcha = metrics.counter({
    name: 'qtiauth_games_captcha_total',
    help: 'CAPTCHA prompts on key redemption, by result: shown, solved or failed.',
    labelNames: ['result'],
  });
  return {
    granted: (source) => {
      grants.inc({ source });
    },
    revoked: (source) => {
      revokes.inc({ source });
    },
    keyRedeemed: (outcome) => {
      keyRedemptions.inc({ outcome });
    },
    keysGenerated: (count) => {
      if (count > 0) keysGenerated.inc(count);
    },
    captcha: (result) => {
      captcha.inc({ result });
    },
  };
}
