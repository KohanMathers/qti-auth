import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  generateSigningKey,
  publicJwkMatches,
  type SigningAlgorithm,
  SIGNING_ALGORITHMS,
} from './algorithms.ts';

function canSign(algorithm: SigningAlgorithm): void {
  const generated = generateSigningKey(algorithm);
  expect(generated.publicJwk).not.toHaveProperty('d');
  expect(publicJwkMatches(generated.publicJwk, algorithm)).toBe(true);
  const privateKey = createPrivateKey({
    key: generated.privateDer,
    format: 'der',
    type: 'pkcs8',
  });
  const publicKey = createPublicKey({ key: generated.publicJwk, format: 'jwk' });
  const data = Buffer.from('qtiauth');
  const signature =
    algorithm === 'EdDSA' ? sign(null, data, privateKey) : sign('sha256', data, privateKey);
  const valid =
    algorithm === 'EdDSA'
      ? verify(null, data, publicKey, signature)
      : verify('sha256', data, publicKey, signature);
  expect(valid).toBe(true);
}

describe('generateSigningKey', () => {
  it.each(SIGNING_ALGORITHMS)('creates a %s key that can sign and verify', (algorithm) => {
    canSign(algorithm);
  });
});
