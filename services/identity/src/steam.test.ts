import { describe, expect, it } from 'vitest';

import {
  steamAuthorizationUrl,
  steamIdFromClaimedId,
  steamReturnTo,
  verifySteamAssertion,
} from './steam.ts';

describe('Steam OpenID 2.0', () => {
  it('builds a checkid_setup URL and reads the steam id from claimed_id', () => {
    const url = new URL(
      steamAuthorizationUrl({
        realm: 'https://me.example.com',
        returnTo: steamReturnTo('https://me.example.com/auth/social/steam/callback', 'st'),
      }),
    );
    expect(url.origin + url.pathname).toBe('https://steamcommunity.com/openid/login');
    expect(url.searchParams.get('openid.mode')).toBe('checkid_setup');
    expect(steamIdFromClaimedId('https://steamcommunity.com/openid/id/76561198000000000')).toBe(
      '76561198000000000',
    );
    expect(
      steamIdFromClaimedId('https://evil.example/openid/id/76561198000000000'),
    ).toBeUndefined();
  });

  it('checks return_to, claimed_id and Steam’s is_valid response', async () => {
    const params = new URLSearchParams({
      'openid.mode': 'id_res',
      'openid.claimed_id': 'https://steamcommunity.com/openid/id/76561198000000000',
      'openid.identity': 'https://steamcommunity.com/openid/id/76561198000000000',
      'openid.return_to': 'https://me.example.com/auth/social/steam/callback?state=st',
    });
    const steamId = await verifySteamAssertion(params, {
      redirectUri: 'https://me.example.com/auth/social/steam/callback',
      state: 'st',
      fetch: () =>
        Promise.resolve(new Response('ns:http://specs.openid.net/auth/2.0\nis_valid:true\n')),
    });
    expect(steamId).toBe('76561198000000000');

    const badReturn = new URLSearchParams(params);
    badReturn.set('openid.return_to', 'https://evil.example/callback?state=st');
    expect(
      await verifySteamAssertion(badReturn, {
        redirectUri: 'https://me.example.com/auth/social/steam/callback',
        state: 'st',
        fetch: () => Promise.resolve(new Response('is_valid:true')),
      }),
    ).toBeUndefined();
  });
});
