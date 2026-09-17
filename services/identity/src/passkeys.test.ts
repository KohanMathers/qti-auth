import { randomUUIDv7 } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { softwarePasskey } from './passkey-testing.ts';
import {
  passkeyAuthenticationOptions,
  passkeyRegistrationOptions,
  uuidBytes,
  verifyPasskeyAuthentication,
  verifyPasskeyRegistration,
} from './passkeys.ts';

const ORIGIN = 'https://me.example.com';
const rp = { name: 'Example Account', rpID: 'me.example.com', origins: [ORIGIN] };

describe('passkeys', () => {
  it('registers and authenticates a software passkey', async () => {
    const userId = randomUUIDv7();
    const authenticator = await softwarePasskey(ORIGIN);
    const creation = await passkeyRegistrationOptions({
      rp,
      userId,
      userName: 'sam@example.com',
      exclude: [],
    });
    expect(creation.user.id).toBe(Buffer.from(uuidBytes(userId)).toString('base64url'));

    const attested = await authenticator.register(creation);
    const registered = await verifyPasskeyRegistration({
      rp,
      challenge: creation.challenge,
      response: attested,
    });
    expect(registered).toMatchObject({ credentialId: authenticator.id, counter: 0 });
    if (registered === undefined) return;

    const assertion = await passkeyAuthenticationOptions({
      rp,
      allow: [{ id: registered.credentialId }],
    });
    const asserted = await authenticator.authenticate(assertion);
    const verified = await verifyPasskeyAuthentication({
      rp,
      challenge: assertion.challenge,
      response: asserted,
      credential: {
        id: registered.credentialId,
        publicKey: registered.publicKey,
        counter: registered.counter,
        transports: [],
      },
    });
    expect(verified?.newCounter).toBeGreaterThan(registered.counter);
  });
});
