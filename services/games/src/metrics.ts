import type { EntitlementSource } from '@qtiauth/config';
import type { Metrics } from '@qtiauth/observability';

export interface GamesMetrics {
  granted: (source: EntitlementSource) => void;
  revoked: (source: EntitlementSource) => void;
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
  return {
    granted: (source) => {
      grants.inc({ source });
    },
    revoked: (source) => {
      revokes.inc({ source });
    },
  };
}
