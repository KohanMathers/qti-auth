import { createPrivateKey } from 'node:crypto';

import { generateSigningKey } from '@qtiauth/keys';
import { describe, expect, it } from 'vitest';

import {
  ACCESS_TOKEN_TYPE,
  atHash,
  ID_TOKEN_TYPE,
  publicKeyFromJwk,
  signJwt,
  verifyJwt,
} from './jwt.ts';

describe('signJwt', () => {
  it('signs and verifies ES256 with ieee-p1363 signatures', () => {
    const generated = generateSigningKey('ES256');
    const privateKey = createPrivateKey({
      key: generated.privateDer,
      format: 'der',
      type: 'pkcs8',
    });
    const publicKey = publicKeyFromJwk(generated.publicJwk);
    expect(publicKey).toBeDefined();
    const token = signJwt({
      header: { alg: 'ES256', typ: ID_TOKEN_TYPE, kid: 'k1' },
      payload: {
        iss: 'https://issuer.example',
        aud: 'client',
        exp: Math.floor(Date.now() / 1000) + 60,
        iat: Math.floor(Date.now() / 1000),
      },
      privateKey,
    });
    const verified = verifyJwt(token, {
      algorithm: 'ES256',
      typ: ID_TOKEN_TYPE,
      issuer: 'https://issuer.example',
      audience: 'client',
      getKey: (kid) => (kid === 'k1' ? publicKey : undefined),
    });
    expect(verified?.header.kid).toBe('k1');
    expect(atHash(token, 'ES256')).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('signs and verifies RS256 access tokens', () => {
    const generated = generateSigningKey('RS256');
    const privateKey = createPrivateKey({
      key: generated.privateDer,
      format: 'der',
      type: 'pkcs8',
    });
    const publicKey = publicKeyFromJwk(generated.publicJwk);
    const token = signJwt({
      header: { alg: 'RS256', typ: ACCESS_TOKEN_TYPE, kid: 'k2' },
      payload: {
        iss: 'https://issuer.example',
        aud: 'https://api.example',
        exp: Math.floor(Date.now() / 1000) + 60,
        iat: Math.floor(Date.now() / 1000),
      },
      privateKey,
    });
    expect(
      verifyJwt(token, {
        algorithm: 'RS256',
        typ: ACCESS_TOKEN_TYPE,
        issuer: 'https://issuer.example',
        audience: 'https://api.example',
        getKey: () => publicKey,
      }),
    ).toBeDefined();
    expect(
      verifyJwt(token, {
        algorithm: 'RS256',
        typ: ID_TOKEN_TYPE,
        issuer: 'https://issuer.example',
        audience: 'https://api.example',
        getKey: () => publicKey,
      }),
    ).toBeUndefined();
  });
});
