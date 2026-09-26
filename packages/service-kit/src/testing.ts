import { generateKeyPairSync, randomUUID } from 'node:crypto';

import { type Bus, type RpcServer, serveRpc } from '@qtiauth/bus';

import {
  type Identity,
  IDENTITY_HEADER,
  type IdentityKeySource,
  type JsonWebKeySet,
  type PublicJwk,
  signIdentityToken,
  type SigningKey,
} from './identity.ts';
import { IDENTITY_KEYS_METHOD, IDENTITY_KEYS_SERVICE, staticIdentityKeys } from './keys.ts';

export interface TestIdentityKey {
  signingKey: SigningKey;
  jwks: JsonWebKeySet;
  keys: IdentityKeySource;
}

export function generateIdentityKey(kid: string = randomUUID()): TestIdentityKey {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const jwks = { keys: [{ ...(publicKey.export({ format: 'jwk' }) as PublicJwk), kid }] };
  return { signingKey: { kid, privateKey }, jwks, keys: staticIdentityKeys(jwks) };
}

export function testIdentity(overrides: Partial<Identity> = {}): Identity {
  return {
    request_id: randomUUID(),
    auth: 'session',
    sub: randomUUID(),
    sid: randomUUID(),
    client_id: null,
    game_id: null,
    scopes: [],
    permissions: [],
    account_state: 'active',
    restrictions: [],
    age_band: 'adult',
    parental_controls: null,
    amr: ['pwd'],
    acr: 'aal1',
    ...overrides,
  };
}

export function identityHeaders(
  key: TestIdentityKey,
  audience: string,
  overrides: Partial<Identity> = {},
): Record<string, string> {
  return {
    [IDENTITY_HEADER]: signIdentityToken(testIdentity(overrides), {
      audience,
      key: key.signingKey,
    }),
  };
}

export function serveTestIdentityKeys(bus: Bus, key: TestIdentityKey): RpcServer {
  if (bus.service !== IDENTITY_KEYS_SERVICE) {
    throw new Error(`Serve identity keys from a bus connected as ${IDENTITY_KEYS_SERVICE}`);
  }
  return serveRpc(bus, {
    method: IDENTITY_KEYS_METHOD,
    handler: () => Promise.resolve(key.jwks),
    onError: () => undefined,
  });
}
