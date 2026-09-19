import { describe, expect, it } from 'vitest';

import { pkceChallenge, pkceMatches, pkceVerifier } from './pkce.ts';

describe('pkce', () => {
  it('accepts the verifier that produced the challenge', () => {
    const verifier = pkceVerifier();
    const challenge = pkceChallenge(verifier);
    expect(pkceMatches(verifier, challenge)).toBe(true);
    expect(pkceMatches(`${verifier}x`, challenge)).toBe(false);
    expect(pkceMatches('short', challenge)).toBe(false);
  });
});
