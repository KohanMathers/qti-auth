import { randomBytes } from 'node:crypto';

import { signIdentityToken, staticIdentityKeys, verifyIdentityToken } from '@qtiauth/service-kit';
import { testIdentity } from '@qtiauth/service-kit/testing';
import { describe, expect, it } from 'vitest';

import { KeyringError, memoryKeySetStore, openKeyring } from './identity-keys.ts';

const DAY = 86_400_000;
const encryptionKey = randomBytes(32);

function setup() {
  let at = Date.parse('2026-09-01T00:00:00Z');
  const store = memoryKeySetStore();
  const open = () =>
    openKeyring({
      store,
      encryptionKey,
      rotateAfter: 30 * DAY,
      retainAfterRotation: 3_600_000,
      now: () => at,
    });
  return {
    store,
    open,
    advance: (ms: number) => {
      at += ms;
    },
    now: () => new Date(at),
  };
}

describe('openKeyring', () => {
  it('creates one key, stored encrypted, and shares it between replicas', async () => {
    const { store, open } = setup();
    const first = await open();
    const second = await open();
    expect(second.signingKey().kid).toBe(first.signingKey().kid);

    const stored = JSON.stringify(store.value());
    const der = first.signingKey().privateKey.export({ format: 'der', type: 'pkcs8' });
    expect(stored).not.toContain(der.toString('base64'));
    expect(stored).not.toContain(der.toString('base64url'));
    expect(store.value()?.keys.keys).toHaveLength(1);
  });

  it('signs tokens that verify against its JWKS', async () => {
    const { open, now } = setup();
    const keyring = await open();
    const token = signIdentityToken(testIdentity(), {
      audience: 'identity',
      key: keyring.signingKey(),
      now: now(),
    });
    const keys = staticIdentityKeys(await keyring.jwks());
    await expect(
      verifyIdentityToken(token, { audience: 'identity', keys, clockTolerance: 5_000, now: now() }),
    ).resolves.toMatchObject({ aud: 'identity' });
    expect((await keyring.jwks()).keys[0]).toMatchObject({
      kty: 'OKP',
      crv: 'Ed25519',
      alg: 'EdDSA',
      use: 'sig',
    });
  });

  it('rotates when due and keeps publishing the old key for a while', async () => {
    const { open, advance } = setup();
    const keyring = await open();
    const replica = await open();
    const original = keyring.signingKey().kid;

    advance(29 * DAY);
    expect(await keyring.rotateIfDue()).toBe(false);

    advance(DAY);
    expect(await keyring.rotateIfDue()).toBe(true);
    expect(await replica.rotateIfDue()).toBe(false);
    const rotated = keyring.signingKey().kid;
    expect(rotated).not.toBe(original);
    expect(replica.signingKey().kid).toBe(rotated);
    expect((await keyring.jwks()).keys.map((key) => key.kid)).toEqual([rotated, original]);

    advance(3_600_000);
    expect((await keyring.jwks()).keys.map((key) => key.kid)).toEqual([rotated]);
  });

  it('picks up a rotation made by another replica', async () => {
    const { open, advance } = setup();
    const keyring = await open();
    const replica = await open();
    await replica.rotate();
    expect(keyring.signingKey().kid).not.toBe(replica.signingKey().kid);
    advance(1_000);
    expect((await keyring.jwks()).keys).toHaveLength(2);
    expect(keyring.signingKey().kid).toBe(replica.signingKey().kid);
  });

  it('refuses to start with the wrong encryption key', async () => {
    const { store, open } = setup();
    await open();
    await expect(
      openKeyring({
        store,
        encryptionKey: randomBytes(32),
        rotateAfter: 30 * DAY,
        retainAfterRotation: 3_600_000,
      }),
    ).rejects.toThrow(KeyringError);
  });
});
