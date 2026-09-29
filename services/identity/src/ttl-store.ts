import { KEY_PREFIX, type Valkey } from '@qtiauth/valkey';

export interface TtlStore<T> {
  put: (key: string, value: T, ttlMs?: number) => Promise<void>;
  take: (key: string) => Promise<T | undefined>;
}

export interface TtlStoreSettings {
  namespace: string;
  defaultTtl: number;
}

export function memoryTtlStore<T>(settings: TtlStoreSettings): TtlStore<T> {
  const items = new Map<string, { value: T; expiresAt: number }>();
  return {
    put(key, value, ttlMs = settings.defaultTtl) {
      items.set(key, { value, expiresAt: Date.now() + ttlMs });
      return Promise.resolve();
    },
    take(key) {
      const item = items.get(key);
      items.delete(key);
      if (item === undefined || item.expiresAt <= Date.now()) return Promise.resolve(undefined);
      return Promise.resolve(item.value);
    },
  };
}

export function valkeyTtlStore<T>(client: Valkey, settings: TtlStoreSettings): TtlStore<T> {
  const keyFor = (key: string) => `${KEY_PREFIX}${settings.namespace}${key}`;
  return {
    async put(key, value, ttlMs = settings.defaultTtl) {
      await client.set(keyFor(key), JSON.stringify(value), 'PX', ttlMs);
    },
    async take(key) {
      const raw = await client.getdel(keyFor(key));
      if (raw === null) return undefined;
      return JSON.parse(raw) as T;
    },
  };
}
