import { createPrivateKey, generateKeyPairSync, type KeyObject, randomUUID } from 'node:crypto';

import { Kvm } from '@nats-io/kv';
import type { Bus } from '@qtiauth/bus';
import type { JsonWebKeySet, SigningKey } from '@qtiauth/service-kit';
import * as z from 'zod';

import { open, seal, sealedSecretSchema } from './envelope.ts';

export const KEYS_BUCKET = 'qtiauth_gateway';
export const KEYS_ENTRY = 'identity_keys';

const JWKS_MAX_AGE = 1_000;
const MAX_ATTEMPTS = 5;

const storedKeySchema = z.strictObject({
  kid: z.string().min(1),
  created_at: z.iso.datetime(),
  replaced_at: z.iso.datetime().nullable(),
  public_jwk: z.strictObject({ kty: z.literal('OKP'), crv: z.literal('Ed25519'), x: z.string() }),
  private_key: sealedSecretSchema,
});

export const keySetSchema = z.strictObject({
  version: z.literal(1),
  keys: z.array(storedKeySchema),
});

export type StoredKey = z.output<typeof storedKeySchema>;
export type KeySet = z.output<typeof keySetSchema>;

export interface VersionedKeySet {
  keys: KeySet;
  revision: number;
}

export interface KeySetStore {
  load: () => Promise<VersionedKeySet | null>;
  save: (keys: KeySet, revision: number | null) => Promise<boolean>;
}

export interface KeyringOptions {
  store: KeySetStore;
  encryptionKey: Buffer;
  rotateAfter: number;
  retainAfterRotation: number;
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

export function memoryKeySetStore(): KeySetStore & { value: () => VersionedKeySet | null } {
  let stored: VersionedKeySet | null = null;
  return {
    value: () => stored,
    load: () => Promise.resolve(stored && structuredClone(stored)),
    save: (keys, revision) => {
      if ((stored?.revision ?? null) !== revision) return Promise.resolve(false);
      stored = { keys: structuredClone(keys), revision: (revision ?? 0) + 1 };
      return Promise.resolve(true);
    },
  };
}

export async function kvKeySetStore(bus: Bus): Promise<KeySetStore> {
  const kv = await new Kvm(bus.js).create(KEYS_BUCKET, {
    history: 1,
    replicas: bus.config.streams.replicas,
  });
  const load = async (): Promise<VersionedKeySet | null> => {
    const entry = await kv.get(KEYS_ENTRY);
    if (entry?.operation !== 'PUT') return null;
    return { keys: keySetSchema.parse(entry.json()), revision: entry.revision };
  };
  return {
    load,
    save: async (keys, revision) => {
      const data = JSON.stringify(keySetSchema.parse(keys));
      try {
        if (revision === null) await kv.create(KEYS_ENTRY, data);
        else await kv.update(KEYS_ENTRY, data, revision);
        return true;
      } catch (error) {
        const current = await load();
        if ((current?.revision ?? null) !== revision) return false;
        throw error;
      }
    },
  };
}

function generateKey(encryptionKey: Buffer, at: number): StoredKey {
  const kid = randomUUID();
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' });
  return {
    kid,
    created_at: new Date(at).toISOString(),
    replaced_at: null,
    public_jwk: { kty: 'OKP', crv: 'Ed25519', x: jwk.x ?? '' },
    private_key: seal(privateKey.export({ format: 'der', type: 'pkcs8' }), encryptionKey, kid),
  };
}

function activeKey(keys: KeySet): StoredKey | undefined {
  return keys.keys.find((key) => key.replaced_at === null);
}

export async function openKeyring(options: KeyringOptions): Promise<Keyring> {
  const now = options.now ?? Date.now;
  const { store, encryptionKey } = options;
  const privateKeys = new Map<string, KeyObject>();
  let current: { keys: KeySet; active: StoredKey; loadedAt: number } | undefined;

  const published = (keys: KeySet) =>
    keys.keys.filter(
      (key) =>
        key.replaced_at === null ||
        Date.parse(key.replaced_at) + options.retainAfterRotation > now(),
    );

  const apply = (keys: KeySet) => {
    const active = activeKey(keys);
    if (!active) throw new KeyringError('The identity key set has no active key');
    if (!privateKeys.has(active.kid)) {
      let der: Buffer;
      try {
        der = open(active.private_key, encryptionKey, active.kid);
      } catch (error) {
        throw new KeyringError(
          `Can't decrypt identity key ${active.kid}. Is gateway.identity_keys.encryption_key the key it was created with? (${error instanceof Error ? error.message : String(error)})`,
        );
      }
      privateKeys.set(active.kid, createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }));
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
        if (!loaded) throw new KeyringError('No identity keys to load');
        apply(loaded.keys);
        return false;
      }
      if (await store.save(next, loaded?.revision ?? null)) {
        apply(next);
        return true;
      }
    }
    throw new KeyringError('Identity keys kept changing while being updated');
  };

  const replaceActive = (keys: KeySet): KeySet => {
    const at = now();
    const replacedAt = new Date(at).toISOString();
    return {
      version: 1,
      keys: [
        generateKey(encryptionKey, at),
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
    if (keys === null) return { version: 1, keys: [generateKey(encryptionKey, now())] };
    return isDue(keys) ? replaceActive(keys) : null;
  });

  const loaded = () => {
    if (!current) throw new KeyringError('Identity keys are not loaded');
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
      if (!privateKey) throw new KeyringError('Identity keys are not loaded');
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
          alg: 'EdDSA',
          use: 'sig',
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
