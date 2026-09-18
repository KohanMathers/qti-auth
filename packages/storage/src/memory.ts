import { type ObjectStore, type StoredObject } from './store.ts';

interface MemoryEntry {
  body: Uint8Array;
  contentType: string;
  lastModified: Date;
}

export function createMemoryStore(clock: () => Date = () => new Date()): ObjectStore {
  const objects = new Map<string, MemoryEntry>();

  return {
    put(key, body, contentType) {
      objects.set(key, { body, contentType, lastModified: clock() });
      return Promise.resolve();
    },
    get(key) {
      const entry = objects.get(key);
      return Promise.resolve(entry === undefined ? undefined : entry.body);
    },
    delete(key) {
      objects.delete(key);
      return Promise.resolve();
    },
    deletePrefix(prefix) {
      let count = 0;
      for (const key of [...objects.keys()]) {
        if (key.startsWith(prefix)) {
          objects.delete(key);
          count += 1;
        }
      }
      return Promise.resolve(count);
    },
    list(prefix) {
      const listed: StoredObject[] = [];
      for (const [key, entry] of objects) {
        if (key.startsWith(prefix)) {
          listed.push({ key, lastModified: entry.lastModified, size: entry.body.byteLength });
        }
      }
      return Promise.resolve(listed.sort((a, b) => (a.key < b.key ? -1 : 1)));
    },
    presignGet(key, expiresSeconds) {
      return Promise.resolve(`memory://${key}?expires=${String(expiresSeconds)}`);
    },
    presignPut(key, contentType, expiresSeconds) {
      return Promise.resolve(
        `memory://${key}?content_type=${encodeURIComponent(contentType)}&expires=${String(expiresSeconds)}`,
      );
    },
    checkBucket: () => Promise.resolve(),
    ensureBucket: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };
}
