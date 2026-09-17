import type { Valkey } from '@qtiauth/valkey';

import { contextAttachment } from './attachments.ts';
import {
  memoryTtlStore,
  type TtlStore,
  type TtlStoreSettings,
  valkeyTtlStore,
} from './ttl-store.ts';

export const OAUTH_STATE_TTL = 10 * 60_000;

const SETTINGS: TtlStoreSettings = { namespace: 'identity:oauth:', defaultTtl: OAUTH_STATE_TTL };

export type SocialIntent = 'signin' | 'link';

export interface OauthState {
  provider: string;
  intent: SocialIntent;
  userId: string | null;
  sessionId: string | null;
  bindingHash: string;
  returnTo: string | null;
  locale: string | null;
  redirectUri: string;
  codeVerifier: string | null;
  nonce: string | null;
  createdAt: number;
}

export type OauthStateStore = TtlStore<OauthState>;

const attachment = contextAttachment<OauthStateStore>();

export const attachOauthStore = attachment.attach;
export const oauthStoreOf = attachment.of;

export function memoryOauthStore(): OauthStateStore {
  return memoryTtlStore<OauthState>(SETTINGS);
}

export function valkeyOauthStore(client: Valkey): OauthStateStore {
  return valkeyTtlStore<OauthState>(client, SETTINGS);
}
