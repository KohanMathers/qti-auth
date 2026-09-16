import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  IDENTITY_TOKEN_LIFETIME,
  type IdentityTokenFailure,
  identityFromClaims,
  publicKeyFromJwk,
  signIdentityToken,
  verifyIdentityToken,
} from './identity.ts';
import { staticIdentityKeys } from './keys.ts';
import { generateIdentityKey, testIdentity } from './testing.ts';

const key = generateIdentityKey('k1');
const now = new Date('2026-09-16T12:00:00Z');
const verifyOptions = { audience: 'identity', keys: key.keys, clockTolerance: 5_000, now };

async function failure(token: string, options = verifyOptions): Promise<IdentityTokenFailure> {
  const error = await verifyIdentityToken(token, options).then(
    () => undefined,
    (e: unknown) => e as { reason: IdentityTokenFailure },
  );
  if (!error) throw new Error('Token was accepted');
  return error.reason;
}

function tamper(token: string, claims: Record<string, unknown>): string {
  const [header = '', payload = '', signature = ''] = token.split('.');
  const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString()) as object;
  const changed = Buffer.from(JSON.stringify({ ...decoded, ...claims })).toString('base64url');
  return `${header}.${changed}.${signature}`;
}

describe('identity tokens', () => {
  const identity = testIdentity({ permissions: ['users.read'] });
  const token = signIdentityToken(identity, { audience: 'identity', key: key.signingKey, now });

  it('round-trips the identity', async () => {
    const claims = await verifyIdentityToken(token, verifyOptions);
    expect(claims).toMatchObject({
      iss: 'qtiauth-gateway',
      aud: 'identity',
      exp: claims.iat + IDENTITY_TOKEN_LIFETIME,
    });
    expect(identityFromClaims(claims)).toEqual(identity);
  });

  it('rejects missing and malformed tokens', async () => {
    expect(await failure('')).toBe('missing');
    expect(await failure('a.b')).toBe('malformed');
    expect(await failure('!!.b.c')).toBe('malformed');
  });

  it('rejects other algorithms and unknown keys', async () => {
    const [, payload, signature] = token.split('.');
    const none = Buffer.from(JSON.stringify({ alg: 'none', kid: 'k1' })).toString('base64url');
    expect(await failure(`${none}.${payload ?? ''}.${signature ?? ''}`)).toBe(
      'unsupported_algorithm',
    );

    const other = generateIdentityKey('k2');
    const foreign = signIdentityToken(identity, {
      audience: 'identity',
      key: other.signingKey,
      now,
    });
    expect(await failure(foreign)).toBe('unknown_key');

    const sameKid = generateIdentityKey('k1');
    const forged = signIdentityToken(identity, {
      audience: 'identity',
      key: sameKid.signingKey,
      now,
    });
    expect(await failure(forged)).toBe('bad_signature');
  });

  it('rejects changed claims', async () => {
    expect(await failure(tamper(token, { permissions: ['*'] }))).toBe('bad_signature');
  });

  it('checks audience, times and lifetime', async () => {
    const sign = (options: { audience?: string; at?: Date; lifetime?: number }) =>
      signIdentityToken(identity, {
        audience: options.audience ?? 'identity',
        key: key.signingKey,
        now: options.at ?? now,
        ...(options.lifetime === undefined ? {} : { lifetime: options.lifetime }),
      });

    expect(await failure(sign({ audience: 'games' }))).toBe('wrong_audience');
    expect(await failure(sign({ at: new Date(now.getTime() - 66_000) }))).toBe('expired');
    expect(await failure(sign({ at: new Date(now.getTime() + 6_000) }))).toBe('not_yet_valid');
    expect(await failure(sign({ lifetime: 3600 }))).toBe('lifetime_too_long');

    await expect(
      verifyIdentityToken(sign({ at: new Date(now.getTime() - 64_000) }), verifyOptions),
    ).resolves.toBeDefined();
    await expect(
      verifyIdentityToken(sign({ at: new Date(now.getTime() + 4_000) }), verifyOptions),
    ).resolves.toBeDefined();
  });

  it('refuses to sign invalid claims', () => {
    expect(() =>
      signIdentityToken(
        { ...identity, account_state: 'sleeping' as 'active' },
        { audience: 'identity', key: key.signingKey },
      ),
    ).toThrow();
  });
});

describe('publicKeyFromJwk', () => {
  it('only accepts Ed25519 public keys', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    expect(() => publicKeyFromJwk(privateKey.export({ format: 'jwk' }))).toThrow('public JWKs');
    expect(() => publicKeyFromJwk({ kty: 'RSA', x: 'AQAB' })).toThrow('Ed25519');
    expect(publicKeyFromJwk(publicKey.export({ format: 'jwk' })).asymmetricKeyType).toBe('ed25519');
  });

  it('needs a kid for every key in a set', () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    expect(() => staticIdentityKeys({ keys: [publicKey.export({ format: 'jwk' })] })).toThrow(
      'needs a kid',
    );
  });
});
