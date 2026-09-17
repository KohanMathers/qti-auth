import type { Valkey } from '@qtiauth/valkey';

import { contextAttachment } from './attachments.ts';
import {
  memoryTtlStore,
  type TtlStore,
  type TtlStoreSettings,
  valkeyTtlStore,
} from './ttl-store.ts';

export const BIND_CODE_TTL = 60_000;

const SETTINGS: TtlStoreSettings = { namespace: 'identity:bind:', defaultTtl: BIND_CODE_TTL };

export interface BindCode {
  sessionId: string;
  target: string;
  origin: string;
  returnPath: string;
  createdAt: number;
}

export type BindStore = TtlStore<BindCode>;

const attachment = contextAttachment<BindStore>();

export const attachBindStore = attachment.attach;
export const bindStoreOf = attachment.of;

export function memoryBindStore(): BindStore {
  return memoryTtlStore<BindCode>(SETTINGS);
}

export function valkeyBindStore(client: Valkey): BindStore {
  return valkeyTtlStore<BindCode>(client, SETTINGS);
}
