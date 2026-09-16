import { describe, expect, it, vi } from 'vitest';

import type { JsonWebKeySet } from './identity.ts';
import { fetchedIdentityKeys } from './keys.ts';
import { generateIdentityKey } from './testing.ts';

function clock() {
  let time = 0;
  return {
    now: () => time,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

describe('fetchedIdentityKeys', () => {
  const first = generateIdentityKey('k1');
  const second = generateIdentityKey('k2');

  it('caches keys until the refresh interval passes', async () => {
    const time = clock();
    const fetch = vi.fn(() => Promise.resolve(first.jwks));
    const keys = fetchedIdentityKeys({ fetch, refreshInterval: 60_000, now: time.now });

    expect(await keys.get('k1')).toBeDefined();
    await keys.get('k1');
    expect(fetch).toHaveBeenCalledTimes(1);

    time.advance(60_000);
    await keys.get('k1');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('fetches again for an unknown key, at most once a second', async () => {
    const time = clock();
    let set: JsonWebKeySet = first.jwks;
    const fetch = vi.fn(() => Promise.resolve(set));
    const keys = fetchedIdentityKeys({ fetch, refreshInterval: 60_000, now: time.now });

    await keys.get('k1');
    set = { keys: [...first.jwks.keys, ...second.jwks.keys] };
    expect(await keys.get('k2')).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);

    time.advance(1_000);
    expect(await keys.get('k2')).toBeDefined();
    expect(await keys.get('missing')).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('shares one fetch between concurrent lookups', async () => {
    const fetch = vi.fn(() => Promise.resolve(first.jwks));
    const keys = fetchedIdentityKeys({ fetch, refreshInterval: 60_000 });
    await Promise.all([keys.get('k1'), keys.get('k1'), keys.get('k1')]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps using known keys when a refresh fails, and fails without any', async () => {
    const time = clock();
    const fetch = vi
      .fn<() => Promise<JsonWebKeySet>>()
      .mockResolvedValueOnce(first.jwks)
      .mockRejectedValue(new Error('no responders'));
    const keys = fetchedIdentityKeys({ fetch, refreshInterval: 60_000, now: time.now });

    await keys.get('k1');
    time.advance(60_000);
    expect(await keys.get('k1')).toBeDefined();

    const empty = fetchedIdentityKeys({
      fetch: () => Promise.reject(new Error('no responders')),
      refreshInterval: 60_000,
    });
    await expect(empty.get('k1')).rejects.toMatchObject({ reason: 'keys_unavailable' });
  });
});
