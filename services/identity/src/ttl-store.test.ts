import { describe, expect, it, vi } from 'vitest';

import { memoryTtlStore } from './ttl-store.ts';

const SETTINGS = { namespace: 'identity:test:', defaultTtl: 60_000 };

describe('memoryTtlStore', () => {
  it('reads a value once', async () => {
    const store = memoryTtlStore<{ hello: string }>(SETTINGS);
    await store.put('key', { hello: 'world' });
    expect(await store.take('key')).toEqual({ hello: 'world' });
    expect(await store.take('key')).toBeUndefined();
  });

  it('forgets a value once its ttl passes', async () => {
    vi.useFakeTimers();
    try {
      const store = memoryTtlStore<string>(SETTINGS);
      await store.put('short', 'value', 1_000);
      vi.advanceTimersByTime(1_001);
      expect(await store.take('short')).toBeUndefined();

      await store.put('default', 'value');
      vi.advanceTimersByTime(SETTINGS.defaultTtl - 1);
      expect(await store.take('default')).toBe('value');
    } finally {
      vi.useRealTimers();
    }
  });

  it('has nothing for an unknown key', async () => {
    const store = memoryTtlStore<string>(SETTINGS);
    expect(await store.take('missing')).toBeUndefined();
  });
});
