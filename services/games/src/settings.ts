import { parseEncryptionKey } from '@qtiauth/keys';

import type { Context } from './service.ts';

const cache = new WeakMap<object, Buffer>();

export function gamesEncryptionKey(config: Context['config']): Buffer {
  const cached = cache.get(config);
  if (cached) return cached;
  const key = parseEncryptionKey(config.security.encryption_key, 'security.encryption_key');
  cache.set(config, key);
  return key;
}
