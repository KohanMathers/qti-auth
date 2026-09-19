import type { Bus } from '@qtiauth/bus';
import {
  type Keyring,
  type KeyringOptions,
  type KeySetStore,
  kvKeySetStore as openKvKeySetStore,
  openKeyring as openSharedKeyring,
} from '@qtiauth/keys';

export const KEYS_BUCKET = 'qtiauth_gateway';
export const KEYS_ENTRY = 'identity_keys';

export type { Keyring, KeySetStore };
export { KeyringError, keySetSchema, memoryKeySetStore } from '@qtiauth/keys';

type IdentityKeyringOptions = Omit<KeyringOptions, 'algorithm' | 'purpose' | 'setting'>;

export function kvKeySetStore(bus: Bus): Promise<KeySetStore> {
  return openKvKeySetStore(bus, { bucket: KEYS_BUCKET, entry: KEYS_ENTRY });
}

export function openKeyring(options: IdentityKeyringOptions): Promise<Keyring> {
  return openSharedKeyring({
    ...options,
    algorithm: 'EdDSA',
    purpose: 'identity',
    setting: 'gateway.identity_keys.encryption_key',
  });
}
