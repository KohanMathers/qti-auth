import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';

import { generateSigningKey } from '@qtiauth/keys';
import { describe, expect, it } from 'vitest';

import {
  decodeLeaseHeader,
  hashDeviceId,
  LEASE_TOKEN_TYPE,
  type LeasePayload,
  signLease,
  verifyLease,
} from './licensing.ts';

function generatedEd25519(): {
  privateKey: KeyObject;
  publicKey: KeyObject;
} {
  const generated = generateSigningKey('EdDSA');
  const privateKey = createPrivateKey({
    key: generated.privateDer,
    format: 'der',
    type: 'pkcs8',
  });
  const publicKey = createPublicKey({ key: generated.publicJwk, format: 'jwk' });
  return { privateKey, publicKey };
}

const basePayload: LeasePayload = {
  jti: '00000000-0000-4000-8000-000000000001',
  iss: 'qtiauth-games-licensing',
  sub: '11111111-1111-4111-8111-111111111111',
  aud: 'my-game',
  iat: Math.floor(Date.now() / 1_000),
  exp: Math.floor(Date.now() / 1_000) + 3_600,
  game_slug: 'my-game',
  products: [{ slug: 'base', type: 'base', expires_at: null }],
  device_hash: null,
};

describe('lease tokens', () => {
  it('round-trips through signLease and verifyLease with EdDSA', () => {
    const { privateKey, publicKey } = generatedEd25519();
    const token = signLease(basePayload, { alg: 'EdDSA', kid: 'lic-1', privateKey });
    const verified = verifyLease(token, {
      issuer: basePayload.iss,
      getKey: (kid, alg) => (kid === 'lic-1' && alg === 'EdDSA' ? publicKey : undefined),
    });
    expect(verified?.payload.jti).toBe(basePayload.jti);
    expect(verified?.payload.products).toEqual(basePayload.products);
    expect(verified?.header.typ).toBe(LEASE_TOKEN_TYPE);
  });

  it('rejects a lease when the signing key is different', () => {
    const original = generatedEd25519();
    const other = generatedEd25519();
    const token = signLease(basePayload, {
      alg: 'EdDSA',
      kid: 'lic-1',
      privateKey: original.privateKey,
    });
    const verified = verifyLease(token, {
      issuer: basePayload.iss,
      getKey: () => other.publicKey,
    });
    expect(verified).toBeUndefined();
  });

  it('rejects a lease from another issuer', () => {
    const { privateKey, publicKey } = generatedEd25519();
    const token = signLease(basePayload, { alg: 'EdDSA', kid: 'lic-1', privateKey });
    const verified = verifyLease(token, {
      issuer: 'wrong-issuer',
      getKey: () => publicKey,
    });
    expect(verified).toBeUndefined();
  });

  it('rejects an expired lease', () => {
    const { privateKey, publicKey } = generatedEd25519();
    const past = { ...basePayload, iat: 1_000, exp: 2_000 };
    const token = signLease(past, { alg: 'EdDSA', kid: 'lic-1', privateKey });
    const verified = verifyLease(token, {
      issuer: past.iss,
      getKey: () => publicKey,
    });
    expect(verified).toBeUndefined();
  });

  it('returns the header when it decodes cleanly', () => {
    const { privateKey } = generatedEd25519();
    const token = signLease(basePayload, { alg: 'EdDSA', kid: 'lic-1', privateKey });
    expect(decodeLeaseHeader(token)).toEqual({
      alg: 'EdDSA',
      kid: 'lic-1',
      typ: LEASE_TOKEN_TYPE,
    });
  });

  it('rejects a mangled token', () => {
    expect(decodeLeaseHeader('not-a-jwt')).toBeUndefined();
    expect(verifyLease('a.b.c', { issuer: 'x', getKey: () => undefined })).toBeUndefined();
  });
});

describe('hashDeviceId', () => {
  it('hashes the same device id to the same 44-character digest', () => {
    const a = hashDeviceId('device-a');
    const b = hashDeviceId('device-a');
    expect(a).toBe(b);
    expect(a).toHaveLength(43);
  });

  it('hashes different device ids to different digests', () => {
    expect(hashDeviceId('device-a')).not.toBe(hashDeviceId('device-b'));
  });
});
