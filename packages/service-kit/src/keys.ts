import type { KeyObject } from 'node:crypto';

import { type Bus, rpcRequest } from '@qtiauth/bus';

import {
  type IdentityKeySource,
  IdentityTokenError,
  type JsonWebKeySet,
  publicKeyFromJwk,
} from './identity.ts';

export const IDENTITY_KEYS_SERVICE = 'gateway';
export const IDENTITY_KEYS_METHOD = 'identity_keys';

const UNKNOWN_KID_REFETCH_INTERVAL = 1_000;

export interface FetchedKeySourceOptions {
  fetch: () => Promise<JsonWebKeySet>;
  refreshInterval: number;
  now?: () => number;
}

function toKeyMap(set: JsonWebKeySet): Map<string, KeyObject> {
  const keys = new Map<string, KeyObject>();
  for (const jwk of set.keys) {
    if (typeof jwk.kid !== 'string' || jwk.kid === '') {
      throw new IdentityTokenError('keys_unavailable', 'Every identity key needs a kid');
    }
    keys.set(jwk.kid, publicKeyFromJwk(jwk));
  }
  return keys;
}

export function staticIdentityKeys(set: JsonWebKeySet): IdentityKeySource {
  const keys = toKeyMap(set);
  return { get: (kid) => Promise.resolve(keys.get(kid)) };
}

export function fetchedIdentityKeys(options: FetchedKeySourceOptions): IdentityKeySource {
  const now = options.now ?? Date.now;
  let keys: Map<string, KeyObject> | undefined;
  let fetchedAt = Number.NEGATIVE_INFINITY;
  let pending: Promise<Map<string, KeyObject>> | undefined;

  const refresh = (): Promise<Map<string, KeyObject>> => {
    pending ??= options
      .fetch()
      .then((set) => {
        keys = toKeyMap(set);
        return keys;
      })
      .finally(() => {
        fetchedAt = now();
        pending = undefined;
      });
    return pending;
  };

  const load = async (): Promise<Map<string, KeyObject>> => {
    try {
      return await refresh();
    } catch (error) {
      if (keys) return keys;
      if (error instanceof IdentityTokenError) throw error;
      throw new IdentityTokenError('keys_unavailable', "Can't fetch identity keys", {
        cause: error,
      });
    }
  };

  return {
    get: async (kid) => {
      const age = now() - fetchedAt;
      if (!keys || age >= options.refreshInterval) return (await load()).get(kid);
      if (!keys.has(kid) && age >= UNKNOWN_KID_REFETCH_INTERVAL) return (await load()).get(kid);
      return keys.get(kid);
    },
  };
}

export function busIdentityKeys(bus: Bus, refreshInterval: number): IdentityKeySource {
  return fetchedIdentityKeys({
    refreshInterval,
    fetch: async () => {
      const result = await rpcRequest<JsonWebKeySet>(
        bus,
        IDENTITY_KEYS_SERVICE,
        IDENTITY_KEYS_METHOD,
        {},
      );
      if (result.status === 'ok') return result.data;
      throw new IdentityTokenError(
        'keys_unavailable',
        `Can't fetch identity keys from the gateway (${result.status === 'error' ? result.code : result.status})`,
      );
    },
  });
}
