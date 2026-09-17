import { generateKeyPairSync, type KeyObject, sign } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { verifyIdToken } from './jwt.ts';

function jwt(privateKey: KeyObject, header: object, payload: object): string {
  const head = Buffer.from(JSON.stringify(header)).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString(
    'base64url',
  );
  return `${head}.${body}.${signature}`;
}

describe('verifyIdToken', () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: 'https://id.example.com',
    aud: 'client',
    sub: 'user-1',
    nonce: 'abc',
    email: 'sam@example.com',
    email_verified: true,
    exp: now + 300,
  };

  it('accepts a valid RS256 token and rejects a bad nonce or audience', () => {
    const token = jwt(privateKey, { alg: 'RS256', kid: 'k1' }, claims);
    const keys = [{ ...jwk, kid: 'k1', alg: 'RS256' }];
    expect(
      verifyIdToken(token, {
        keys,
        issuer: 'https://id.example.com',
        audience: 'client',
        nonce: 'abc',
      }),
    ).toMatchObject({ sub: 'user-1', email: 'sam@example.com' });
    expect(
      verifyIdToken(token, {
        keys,
        issuer: 'https://id.example.com',
        audience: 'client',
        nonce: 'nope',
      }),
    ).toBeUndefined();
    expect(
      verifyIdToken(token, {
        keys,
        issuer: 'https://id.example.com',
        audience: 'other',
        nonce: 'abc',
      }),
    ).toBeUndefined();
  });
});
