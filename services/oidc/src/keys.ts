import type { Bus } from '@qtiauth/bus';
import {
  type Keyring,
  type KeyringOptions,
  type KeySetStore,
  type SigningAlgorithm,
  kvKeySetStore as openKvKeySetStore,
  openKeyring as openSharedKeyring,
} from '@qtiauth/keys';

import { contextAttachment } from './attachments.ts';

export const KEYS_BUCKET = 'qtiauth_oidc';
export const KEYS_ENTRY = 'signing_keys';

export type { Keyring, KeySetStore };
export { KeyringError, memoryKeySetStore } from '@qtiauth/keys';

const attachment = contextAttachment<Keyring>();
export const attachKeyring = attachment.attach;
export const keyringOf = attachment.of;

type OidcKeyringOptions = Omit<KeyringOptions, 'algorithm' | 'purpose' | 'setting'> & {
  algorithm: SigningAlgorithm;
};

export function kvKeySetStore(bus: Bus): Promise<KeySetStore> {
  return openKvKeySetStore(bus, { bucket: KEYS_BUCKET, entry: KEYS_ENTRY });
}

export function openKeyring(options: OidcKeyringOptions): Promise<Keyring> {
  return openSharedKeyring({
    ...options,
    purpose: 'oidc',
    setting: 'oidc.signing.encryption_key',
  });
}
