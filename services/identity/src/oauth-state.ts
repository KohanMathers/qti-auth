import { KEY_PREFIX, type Valkey } from '@qtiauth/valkey';

export const OAUTH_STATE_TTL = 10 * 60_000;
const KEY = `${KEY_PREFIX}identity:oauth:`;

export type SocialIntent = 'signin' | 'link';

export interface OauthState {
  provider: string;
  intent: SocialIntent;
  userId: string | null;
  returnTo: string | null;
  locale: string | null;
  redirectUri: string;
  codeVerifier: string | null;
  nonce: string | null;
  createdAt: number;
}

export interface OauthStateStore {
  put: (state: string, value: OauthState, ttlMs?: number) => Promise<void>;
  take: (state: string) => Promise<OauthState | undefined>;
}

const attached = new WeakMap<object, OauthStateStore>();

export function attachOauthStore(ctx: object, store: OauthStateStore): void {
  attached.set(ctx, store);
}

export function oauthStoreOf(ctx: object): OauthStateStore | undefined {
  return attached.get(ctx);
}

export function memoryOauthStore(): OauthStateStore {
  const items = new Map<string, { value: OauthState; expiresAt: number }>();
  return {
    put(state, value, ttlMs = OAUTH_STATE_TTL) {
      items.set(state, { value, expiresAt: Date.now() + ttlMs });
      return Promise.resolve();
    },
    take(state) {
      const item = items.get(state);
      items.delete(state);
      if (item === undefined || item.expiresAt <= Date.now()) return Promise.resolve(undefined);
      return Promise.resolve(item.value);
    },
  };
}

export function valkeyOauthStore(client: Valkey): OauthStateStore {
  return {
    async put(state, value, ttlMs = OAUTH_STATE_TTL) {
      await client.set(`${KEY}${state}`, JSON.stringify(value), 'PX', ttlMs);
    },
    async take(state) {
      const raw = await client.getdel(`${KEY}${state}`);
      if (raw === null) return undefined;
      return JSON.parse(raw) as OauthState;
    },
  };
}
