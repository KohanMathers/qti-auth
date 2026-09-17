import { KEY_PREFIX, type Valkey } from '@qtiauth/valkey';

export const BIND_CODE_TTL = 60_000;
const KEY = `${KEY_PREFIX}identity:bind:`;

export interface BindCode {
  sessionId: string;
  target: string;
  origin: string;
  returnPath: string;
  createdAt: number;
}

export interface BindStore {
  put: (code: string, value: BindCode, ttlMs?: number) => Promise<void>;
  take: (code: string) => Promise<BindCode | undefined>;
}

const attached = new WeakMap<object, BindStore>();

export function attachBindStore(ctx: object, store: BindStore): void {
  attached.set(ctx, store);
}

export function bindStoreOf(ctx: object): BindStore | undefined {
  return attached.get(ctx);
}

export function memoryBindStore(): BindStore {
  const items = new Map<string, { value: BindCode; expiresAt: number }>();
  return {
    put(code, value, ttlMs = BIND_CODE_TTL) {
      items.set(code, { value, expiresAt: Date.now() + ttlMs });
      return Promise.resolve();
    },
    take(code) {
      const item = items.get(code);
      items.delete(code);
      if (item === undefined || item.expiresAt <= Date.now()) return Promise.resolve(undefined);
      return Promise.resolve(item.value);
    },
  };
}

export function valkeyBindStore(client: Valkey): BindStore {
  return {
    async put(code, value, ttlMs = BIND_CODE_TTL) {
      await client.set(`${KEY}${code}`, JSON.stringify(value), 'PX', ttlMs);
    },
    async take(code) {
      const raw = await client.getdel(`${KEY}${code}`);
      if (raw === null) return undefined;
      return JSON.parse(raw) as BindCode;
    },
  };
}
