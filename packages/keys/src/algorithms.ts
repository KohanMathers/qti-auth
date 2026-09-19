import { generateKeyPairSync } from 'node:crypto';

export const SIGNING_ALGORITHMS = ['EdDSA', 'ES256', 'RS256'] as const;
export type SigningAlgorithm = (typeof SIGNING_ALGORITHMS)[number];

export type PublicJwk =
  | { kty: 'OKP'; crv: 'Ed25519'; x: string }
  | { kty: 'EC'; crv: 'P-256'; x: string; y: string }
  | { kty: 'RSA'; n: string; e: string };

export interface GeneratedSigningKey {
  publicJwk: PublicJwk;
  privateDer: Buffer;
}

export function generateSigningKey(algorithm: SigningAlgorithm): GeneratedSigningKey {
  switch (algorithm) {
    case 'EdDSA': {
      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      const jwk = publicKey.export({ format: 'jwk' });
      return {
        publicJwk: { kty: 'OKP', crv: 'Ed25519', x: jwk.x ?? '' },
        privateDer: privateKey.export({ format: 'der', type: 'pkcs8' }),
      };
    }
    case 'ES256': {
      const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
      const jwk = publicKey.export({ format: 'jwk' });
      return {
        publicJwk: { kty: 'EC', crv: 'P-256', x: jwk.x ?? '', y: jwk.y ?? '' },
        privateDer: privateKey.export({ format: 'der', type: 'pkcs8' }),
      };
    }
    case 'RS256': {
      const { privateKey, publicKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicExponent: 65537,
      });
      const jwk = publicKey.export({ format: 'jwk' });
      return {
        publicJwk: { kty: 'RSA', n: jwk.n ?? '', e: jwk.e ?? '' },
        privateDer: privateKey.export({ format: 'der', type: 'pkcs8' }),
      };
    }
  }
}

export function publicJwkMatches(jwk: PublicJwk, algorithm: SigningAlgorithm): boolean {
  switch (algorithm) {
    case 'EdDSA':
      return jwk.kty === 'OKP';
    case 'ES256':
      return jwk.kty === 'EC';
    case 'RS256':
      return jwk.kty === 'RSA';
  }
}
