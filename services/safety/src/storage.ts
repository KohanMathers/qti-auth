import { type ObjectStore, tryOpenObjectStore } from '@qtiauth/service-kit';

export function objectStoreOf(config: {
  storage: Parameters<typeof tryOpenObjectStore>[0];
}): ObjectStore | null {
  return tryOpenObjectStore(config.storage);
}
