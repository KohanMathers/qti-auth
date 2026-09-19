import { randomBytes } from 'node:crypto';

import { type Bus, connectBus } from '@qtiauth/bus';
import { sections } from '@qtiauth/config';
import { natsUrl, startNats } from '@qtiauth/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openKeyring } from './keyring.ts';
import { kvKeySetStore } from './store.ts';

const encryptionKey = randomBytes(32);

let nats: Awaited<ReturnType<typeof startNats>>;
let first: Bus;
let second: Bus;

beforeAll(async () => {
  nats = await startNats();
  const config = sections.bus.parse({ servers: [natsUrl(nats)] });
  [first, second] = await Promise.all([
    connectBus(config, 'gateway'),
    connectBus(config, 'gateway'),
  ]);
});

afterAll(async () => {
  await Promise.all([first.close(), second.close()]);
  await nats.stop();
});

describe('kvKeySetStore', () => {
  it('shares encrypted keys across replicas and keeps the old key published after a rotation', async () => {
    const bucket = `qtiauth_keys_${randomBytes(4).toString('hex')}`;
    const options = {
      encryptionKey,
      algorithm: 'EdDSA' as const,
      rotateAfter: 86_400_000,
      retainAfterRotation: 3_600_000,
      purpose: 'identity',
      setting: 'gateway.identity_keys.encryption_key',
    };
    const keyring = await openKeyring({
      ...options,
      store: await kvKeySetStore(first, { bucket, entry: 'identity_keys' }),
    });
    const replica = await openKeyring({
      ...options,
      store: await kvKeySetStore(second, { bucket, entry: 'identity_keys' }),
    });
    expect(replica.signingKey().kid).toBe(keyring.signingKey().kid);

    const original = keyring.signingKey().kid;
    await keyring.rotate();
    await replica.refresh();
    expect(keyring.signingKey().kid).not.toBe(original);
    expect(replica.signingKey().kid).toBe(keyring.signingKey().kid);
    expect((await keyring.jwks()).keys.map((key) => key.kid)).toEqual([
      keyring.signingKey().kid,
      original,
    ]);
  });
});
