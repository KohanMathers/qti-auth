import { createPublicKey, randomBytes, sign, verify } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { KeyringError, openKeyring } from './keyring.ts';
import { memoryKeySetStore } from './store.ts';

const DAY = 86_400_000;
const encryptionKey = randomBytes(32);

function setup() {
  let at = Date.parse('2026-09-01T00:00:00Z');
  const store = memoryKeySetStore();
  const open = () =>
    openKeyring({
      store,
      encryptionKey,
      algorithm: 'EdDSA',
      rotateAfter: 30 * DAY,
      retainAfterRotation: 3_600_000,
      purpose: 'identity',
      setting: 'gateway.identity_keys.encryption_key',
      now: () => at,
    });
  return {
    store,
    open,
    advance: (ms: number) => {
      at += ms;
    },
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

  it('signs with the active key and publishes it in JWKS', async () => {
    const { open } = setup();
    const keyring = await open();
    const data = Buffer.from('identity-token');
    const signature = sign(null, data, keyring.signingKey().privateKey);
    const jwk = (await keyring.jwks()).keys[0];
    if (jwk === undefined) throw new Error('expected a published key');
    expect(jwk).toMatchObject({
      kty: 'OKP',
      crv: 'Ed25519',
      alg: 'EdDSA',
      use: 'sig',
      kid: keyring.signingKey().kid,
    });
    const publicKey = createPublicKey({ key: jwk, format: 'jwk' });
    expect(verify(null, data, publicKey, signature)).toBe(true);
  });

  it('rotates when due and keeps publishing the old key until tokens expire', async () => {
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
    expect(keyring.signingKey().kid).toBe(rotated);

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
        algorithm: 'EdDSA',
        rotateAfter: 30 * DAY,
        retainAfterRotation: 3_600_000,
        purpose: 'identity',
        setting: 'gateway.identity_keys.encryption_key',
      }),
    ).rejects.toThrow(KeyringError);
  });

  it('refuses to rotate with the wrong encryption key, leaving the stored keys alone', async () => {
    const { store, open } = setup();
    await open();
    const before = JSON.stringify(store.value());
    await expect(
      openKeyring({
        store,
        encryptionKey: randomBytes(32),
        algorithm: 'EdDSA',
        rotateAfter: 30 * DAY,
        retainAfterRotation: 3_600_000,
        purpose: 'identity',
        setting: 'gateway.identity_keys.encryption_key',
        now: () => Date.parse('2026-12-01T00:00:00Z'),
      }),
    ).rejects.toThrow(KeyringError);
    expect(JSON.stringify(store.value())).toBe(before);
  });

  it('refuses a stored key from a different algorithm', async () => {
    const store = memoryKeySetStore();
    await openKeyring({
      store,
      encryptionKey,
      algorithm: 'EdDSA',
      rotateAfter: 30 * DAY,
      retainAfterRotation: 3_600_000,
      purpose: 'oidc',
      setting: 'oidc.keys.encryption_key',
    });
    await expect(
      openKeyring({
        store,
        encryptionKey,
        algorithm: 'ES256',
        rotateAfter: 30 * DAY,
        retainAfterRotation: 3_600_000,
        purpose: 'oidc',
        setting: 'oidc.keys.encryption_key',
      }),
    ).rejects.toThrow(/is not a ES256 key/);
  });

  it('generates ES256 and RS256 keys for other purposes', async () => {
    for (const algorithm of ['ES256', 'RS256'] as const) {
      const keyring = await openKeyring({
        store: memoryKeySetStore(),
        encryptionKey,
        algorithm,
        rotateAfter: 30 * DAY,
        retainAfterRotation: 3_600_000,
        purpose: 'oidc',
        setting: 'oidc.keys.encryption_key',
      });
      const jwks = await keyring.jwks();
      expect(jwks.keys[0]?.alg).toBe(algorithm);
      expect(jwks.keys[0]?.kty).toBe(algorithm === 'ES256' ? 'EC' : 'RSA');
    }
  });
});
