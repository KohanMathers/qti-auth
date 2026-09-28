import { randomBytes, randomInt } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { CODE_CHALLENGE } from './oauth-core.ts';
import { extraAuthorizeParams, REQUEST_URI_PREFIX } from './par.ts';
import { pkceChallenge, pkceMatches, pkceVerifier } from './pkce.ts';
import { isRedirectUri, parseRedirectUri, redirectsMatch } from './redirect.ts';

const ITERATIONS = 2000;

const SCHEMES = ['http', 'https', 'javascript', 'data', 'file', 'ftp', 'ws', 'wss', 'urn'];
const HOSTS = ['app.example.com', '127.0.0.1', '[::1]', 'localhost', 'evil.example.net'];
const PATHS = ['/callback', '/oauth/cb', '/', '/../../etc/passwd', '/%00', '/a/b'];

function pick<T>(source: readonly T[]): T {
  const value = source[randomInt(0, source.length)];
  if (value === undefined) throw new Error('pick from empty source');
  return value;
}

function randomUri(): string {
  const scheme = pick(SCHEMES);
  const host = pick(HOSTS);
  const path = pick(PATHS);
  const kind = randomInt(0, 6);
  if (kind === 0) return `${scheme}://${host}${path}`;
  if (kind === 1) return `${scheme}://user:pass@${host}${path}`;
  if (kind === 2) return `${scheme}://${host}${path}#frag`;
  if (kind === 3) return `${scheme}://${host}:${String(randomInt(1, 70000))}${path}`;
  if (kind === 4) return randomBytes(randomInt(0, 256)).toString('base64url');
  return `${scheme}://${host}${path}?x=${randomBytes(4).toString('hex')}`;
}

function randomPkceVerifier(): string {
  const length = randomInt(20, 200);
  return randomBytes(length).toString('base64url').slice(0, length);
}

describe('OIDC parameter fuzz', () => {
  it('never throws on redirect_uri parsing or matching', () => {
    const registered = [
      'https://app.example.com/callback',
      'http://127.0.0.1/callback',
      'http://[::1]/done',
    ];
    for (let i = 0; i < ITERATIONS; i++) {
      const uri = randomUri();
      expect(() => parseRedirectUri(uri)).not.toThrow();
      expect(() => isRedirectUri(uri)).not.toThrow();
      expect(() => redirectsMatch(registered, uri)).not.toThrow();
    }
  });

  it('never accepts a redirect that a registered one does not exactly match', () => {
    const registered = ['https://app.example.com/callback'];
    for (let i = 0; i < ITERATIONS; i++) {
      const uri = randomUri();
      if (redirectsMatch(registered, uri)) {
        const parsed = parseRedirectUri(uri);
        expect(parsed?.protocol).toBe('https:');
        expect(parsed?.hostname).toBe('app.example.com');
        expect(parsed?.pathname).toBe('/callback');
        expect(parsed?.hash).toBe('');
        expect(parsed?.username).toBe('');
        expect(parsed?.password).toBe('');
      }
    }
  });

  it('refuses non-https, non-loopback URIs for registration', () => {
    for (let i = 0; i < 500; i++) {
      const uri = randomUri();
      if (!isRedirectUri(uri)) continue;
      const parsed = parseRedirectUri(uri);
      expect(parsed).toBeDefined();
      if (parsed?.protocol === 'http:') {
        expect(['127.0.0.1', '::1', '[::1]']).toContain(parsed.hostname);
      } else {
        expect(parsed?.protocol).toBe('https:');
      }
    }
  });

  it('never accepts a PKCE verifier that does not match the challenge', () => {
    for (let i = 0; i < 500; i++) {
      const verifier = pkceVerifier();
      const challenge = pkceChallenge(verifier);
      expect(pkceMatches(verifier, challenge)).toBe(true);
      const wrong = randomPkceVerifier();
      if (wrong === verifier) continue;
      expect(pkceMatches(wrong, challenge)).toBe(false);
    }
  });

  it('rejects PKCE verifiers that break the charset or length rule', () => {
    const bad = [
      '',
      'short',
      'a'.repeat(42),
      'a'.repeat(129),
      'good_length_but_illegal!'.padEnd(43, '_'),
      'good_length_but_illegal '.padEnd(43, '_'),
    ];
    for (const raw of bad) {
      expect(pkceMatches(raw, pkceChallenge(pkceVerifier()))).toBe(false);
    }
  });

  it('enforces the CODE_CHALLENGE regex without matching illegal characters', () => {
    expect(CODE_CHALLENGE.test('a'.repeat(43))).toBe(true);
    expect(CODE_CHALLENGE.test('a'.repeat(128))).toBe(true);
    expect(CODE_CHALLENGE.test('a'.repeat(42))).toBe(false);
    expect(CODE_CHALLENGE.test('a'.repeat(129))).toBe(false);
    for (const bad of ['!', '/', '+', '=', ' ', '\n', 'a b']) {
      expect(CODE_CHALLENGE.test(bad.padEnd(43, 'a'))).toBe(false);
    }
  });

  it('spots any extra authorize field when PAR is in use', () => {
    const baseline = { client_id: 'game', request_uri: `${REQUEST_URI_PREFIX}handle` };
    expect(extraAuthorizeParams(baseline)).toBe(false);
    const extras = [
      'redirect_uri',
      'response_type',
      'scope',
      'state',
      'nonce',
      'code_challenge',
      'code_challenge_method',
    ] as const;
    for (const key of extras) {
      const query = { ...baseline, [key]: 'x' };
      expect(extraAuthorizeParams(query), key).toBe(true);
    }
  });
});
