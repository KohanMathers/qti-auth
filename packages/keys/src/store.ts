import { Kvm } from '@nats-io/kv';
import type { Bus } from '@qtiauth/bus';
import * as z from 'zod';

import { sealedSecretSchema } from './envelope.ts';

const publicJwkSchema = z.discriminatedUnion('kty', [
  z.strictObject({ kty: z.literal('OKP'), crv: z.literal('Ed25519'), x: z.string() }),
  z.strictObject({ kty: z.literal('EC'), crv: z.literal('P-256'), x: z.string(), y: z.string() }),
  z.strictObject({ kty: z.literal('RSA'), n: z.string(), e: z.string() }),
]);

const storedKeySchema = z.strictObject({
  kid: z.string().min(1),
  created_at: z.iso.datetime(),
  replaced_at: z.iso.datetime().nullable(),
  public_jwk: publicJwkSchema,
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

export interface KvKeySetStoreOptions {
  bucket: string;
  entry: string;
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

export async function kvKeySetStore(bus: Bus, options: KvKeySetStoreOptions): Promise<KeySetStore> {
  const kv = await new Kvm(bus.js).create(options.bucket, {
    history: 1,
    replicas: bus.config.streams.replicas,
  });
  const load = async (): Promise<VersionedKeySet | null> => {
    const entry = await kv.get(options.entry);
    if (entry?.operation !== 'PUT') return null;
    return { keys: keySetSchema.parse(entry.json()), revision: entry.revision };
  };
  return {
    load,
    save: async (keys, revision) => {
      const data = JSON.stringify(keySetSchema.parse(keys));
      try {
        if (revision === null) await kv.create(options.entry, data);
        else await kv.update(options.entry, data, revision);
        return true;
      } catch (error) {
        const current = await load();
        if ((current?.revision ?? null) !== revision) return false;
        throw error;
      }
    },
  };
}
