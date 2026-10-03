import { createPrivateKey, type KeyObject, randomUUID } from 'node:crypto';

import {
  generateSigningKey,
  type PublicJwk,
  publicJwkMatches,
  type SigningAlgorithm,
} from './algorithms.ts';
import { open, seal } from './envelope.ts';
import { type KeySet, type KeySetStore, type StoredKey } from './store.ts';

const JWKS_MAX_AGE = 1_000;
const MAX_ATTEMPTS = 5;

export interface JsonWebKeySet {
  keys: (PublicJwk & { kid: string; alg: SigningAlgorithm; use: 'sig' })[];
}

export interface SigningKey {
  kid: string;
  privateKey: KeyObject;
}

export interface KeyringOptions {
  store: KeySetStore;
  encryptionKey: Buffer;
  algorithm: SigningAlgorithm;
  rotateAfter: number;
  retainAfterRotation: number;
  purpose: string;
  setting: string;
  now?: () => number;
  onError?: (error: unknown) => void;
}

export interface Keyring {
  signingKey: () => SigningKey;
  activeKeyCreatedAt: () => number;
  jwks: () => Promise<JsonWebKeySet>;
  refresh: () => Promise<void>;
  rotateIfDue: () => Promise<boolean>;
  rotate: () => Promise<void>;
}

export class KeyringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyringError';
  }
}

function generateKey(encryptionKey: Buffer, algorithm: SigningAlgorithm, at: number): StoredKey {
  const kid = randomUUID();
  const generated = generateSigningKey(algorithm);
  return {
    kid,
    created_at: new Date(at).toISOString(),
    replaced_at: null,
    public_jwk: generated.publicJwk,
    private_key: seal(generated.privateDer, encryptionKey, kid),
  };
}

function activeKey(keys: KeySet): StoredKey | undefined {
  return keys.keys.find((key) => key.replaced_at === null);
}

export async function openKeyring(options: KeyringOptions): Promise<Keyring> {
  const now = options.now ?? Date.now;
  const { store, encryptionKey, algorithm, purpose, setting } = options;
  const privateKeys = new Map<string, KeyObject>();
  let current: { keys: KeySet; active: StoredKey; loadedAt: number } | undefined;

  const published = (keys: KeySet) =>
    keys.keys.filter(
      (key) =>
        key.replaced_at === null ||
        Date.parse(key.replaced_at) + options.retainAfterRotation > now(),
    );

  const decryptKey = (key: StoredKey): Buffer => {
    try {
      return open(key.private_key, encryptionKey, key.kid);
    } catch (error) {
      throw new KeyringError(
        `Can't decrypt ${purpose} key ${key.kid}. Is ${setting} the key it was created with? (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  };

  const apply = (keys: KeySet) => {
    for (const key of keys.keys) {
      if (!publicJwkMatches(key.public_jwk, algorithm)) {
        throw new KeyringError(`The ${purpose} key ${key.kid} is not a ${algorithm} key`);
      }
    }
    const active = activeKey(keys);
    if (!active) throw new KeyringError(`The ${purpose} key set has no active key`);
    if (!privateKeys.has(active.kid)) {
      privateKeys.set(
        active.kid,
        createPrivateKey({ key: decryptKey(active), format: 'der', type: 'pkcs8' }),
      );
    }
    for (const kid of privateKeys.keys()) {
      if (!keys.keys.some((key) => key.kid === kid)) privateKeys.delete(kid);
    }
    current = { keys, active, loadedAt: now() };
  };

  const update = async (change: (keys: KeySet | null) => KeySet | null): Promise<boolean> => {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const loaded = await store.load();
      const next = change(loaded?.keys ?? null);
      if (next === null) {
        if (!loaded) throw new KeyringError(`No ${purpose} keys to load`);
        apply(loaded.keys);
        return false;
      }
      if (await store.save(next, loaded?.revision ?? null)) {
        apply(next);
        return true;
      }
    }
    throw new KeyringError(`${purpose} keys kept changing while being updated`);
  };

  const replaceActive = (keys: KeySet): KeySet => {
    const current = activeKey(keys);
    if (current) decryptKey(current);
    const at = now();
    const replacedAt = new Date(at).toISOString();
    return {
      version: 1,
      keys: [
        generateKey(encryptionKey, algorithm, at),
        ...published(keys).map((key) =>
          key.replaced_at === null ? { ...key, replaced_at: replacedAt } : key,
        ),
      ],
    };
  };

  const isDue = (keys: KeySet) => {
    const active = activeKey(keys);
    return !active || Date.parse(active.created_at) + options.rotateAfter <= now();
  };

  await update((keys) => {
    if (keys === null) return { version: 1, keys: [generateKey(encryptionKey, algorithm, now())] };
    return isDue(keys) ? replaceActive(keys) : null;
  });

  const loaded = () => {
    if (!current) throw new KeyringError(`${purpose} keys are not loaded`);
    return current;
  };

  const refresh = async () => {
    const stored = await store.load();
    if (stored) apply(stored.keys);
  };

  return {
    signingKey: () => {
      const { active } = loaded();
      const privateKey = privateKeys.get(active.kid);
      if (!privateKey) throw new KeyringError(`${purpose} keys are not loaded`);
      return { kid: active.kid, privateKey };
    },
    activeKeyCreatedAt: () => Date.parse(loaded().active.created_at),
    jwks: async () => {
      if (now() - loaded().loadedAt >= JWKS_MAX_AGE) {
        await refresh().catch((error: unknown) => {
          options.onError?.(error);
        });
      }
      return {
        keys: published(loaded().keys).map((key) => ({
          ...key.public_jwk,
          kid: key.kid,
          alg: algorithm,
          use: 'sig' as const,
        })),
      };
    },
    refresh,
    rotateIfDue: () =>
      update((keys) => (keys !== null && isDue(keys) ? replaceActive(keys) : null)),
    rotate: async () => {
      await update((keys) => replaceActive(keys ?? { version: 1, keys: [] }));
    },
  };
}
