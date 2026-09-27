import { parseEncryptionKey } from '@qtiauth/keys';

import type { Context } from './service.ts';

export const LICENSE_KEYS_PATH = '/.well-known/qtiauth-license-keys.json';
export const LICENSING_ISSUER = 'qtiauth-games-licensing';
export const REVOCATION_LIST_LIMIT = 5_000;

const cache = new WeakMap<object, Buffer>();

export function gamesEncryptionKey(config: Context['config']): Buffer {
  const cached = cache.get(config);
  if (cached) return cached;
  const key = parseEncryptionKey(config.security.encryption_key, 'security.encryption_key');
  cache.set(config, key);
  return key;
}

export function leaseDurationMs(
  config: Context['config'],
  game: { lease_duration_seconds: number | null },
): number {
  if (game.lease_duration_seconds !== null) return game.lease_duration_seconds * 1_000;
  return config.games.default_lease_duration;
}
