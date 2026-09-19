import { describe, expect, it } from 'vitest';

import { isRedirectUri, parseRedirectUri, redirectsMatch } from './redirect.ts';

describe('redirectsMatch', () => {
  it('matches an exact https URI, including query', () => {
    const registered = ['https://app.example.com/callback?x=1'];
    expect(redirectsMatch(registered, 'https://app.example.com/callback?x=1')).toBe(true);
    expect(redirectsMatch(registered, 'https://app.example.com/callback')).toBe(false);
    expect(redirectsMatch(registered, 'https://app.example.com/callback?x=1&y=2')).toBe(false);
    expect(redirectsMatch(registered, 'https://other.example.com/callback?x=1')).toBe(false);
  });

  it('accepts any port on loopback http URIs', () => {
    const registered = ['http://127.0.0.1/callback', 'http://[::1]/done'];
    expect(redirectsMatch(registered, 'http://127.0.0.1:43821/callback')).toBe(true);
    expect(redirectsMatch(registered, 'http://127.0.0.1/callback')).toBe(true);
    expect(redirectsMatch(registered, 'http://[::1]:9/done')).toBe(true);
    expect(redirectsMatch(registered, 'http://127.0.0.1:43821/other')).toBe(false);
    expect(redirectsMatch(registered, 'https://127.0.0.1/callback')).toBe(false);
  });

  it('accepts https and loopback http URIs for registration', () => {
    expect(isRedirectUri('https://app.example.com/callback')).toBe(true);
    expect(isRedirectUri('http://127.0.0.1/callback')).toBe(true);
    expect(isRedirectUri('http://[::1]/callback')).toBe(true);
    expect(isRedirectUri('http://example.com/callback')).toBe(false);
    expect(isRedirectUri('https://user:pass@app.example.com/callback')).toBe(false);
    expect(parseRedirectUri('https://app.example.com/callback#frag')).toBeUndefined();
    expect(parseRedirectUri('not a url')).toBeUndefined();
  });
});
