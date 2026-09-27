import { describe, expect, it } from 'vitest';

import {
  createSteamWebClient,
  familySharingAllows,
  findSteamApp,
  STEAM_AUTHENTICATE_PATH,
  STEAM_CHECK_OWNERSHIP_PATH,
  type SteamAppSettings,
  SteamApiError,
} from './steam.ts';

const HOST = 'partner.example.test';
const KEY = 'test-publisher-key';
const IDENTITY = 'qtiauth';

const APP: SteamAppSettings = {
  app_id: 900123,
  game_slug: 'my-game',
  ticket_identity: IDENTITY,
  family_sharing: 'allow',
  sync_ownership: true,
};

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

describe('SteamWebClient', () => {
  it('sends the publisher key, appid, ticket and identity when authenticating', async () => {
    const seen: URL[] = [];
    const client = createSteamWebClient({
      host: HOST,
      publisherKey: KEY,
      timeoutMs: 500,
      fetch: (input) => {
        const url = typeof input === 'string' ? new URL(input) : new URL((input as URL).toString());
        seen.push(url);
        return Promise.resolve(
          jsonResponse({
            response: {
              params: {
                result: 'OK',
                steamid: '76561198000000001',
                ownersteamid: '76561198000000001',
                vacbanned: false,
                publisherbanned: false,
              },
            },
          }),
        );
      },
    });
    const result = await client.authenticateTicket({
      appId: APP.app_id,
      ticket: 'deadbeef',
      identity: IDENTITY,
    });
    expect(seen[0]?.host).toBe(HOST);
    expect(seen[0]?.pathname).toBe(STEAM_AUTHENTICATE_PATH);
    expect(seen[0]?.searchParams.get('key')).toBe(KEY);
    expect(seen[0]?.searchParams.get('appid')).toBe(String(APP.app_id));
    expect(seen[0]?.searchParams.get('ticket')).toBe('deadbeef');
    expect(seen[0]?.searchParams.get('identity')).toBe(IDENTITY);
    expect(result).toEqual({
      status: 'ok',
      steamId: '76561198000000001',
      ownerSteamId: '76561198000000001',
      vacBanned: false,
      publisherBanned: false,
    });
  });

  it('surfaces family-sharing owners distinct from the player', async () => {
    const client = createSteamWebClient({
      host: HOST,
      publisherKey: KEY,
      timeoutMs: 500,
      fetch: () =>
        Promise.resolve(
          jsonResponse({
            response: {
              params: {
                result: 'OK',
                steamid: '76561198000000002',
                ownersteamid: '76561198000000003',
                vacbanned: true,
                publisherbanned: false,
              },
            },
          }),
        ),
    });
    const result = await client.authenticateTicket({
      appId: APP.app_id,
      ticket: 'ff',
      identity: IDENTITY,
    });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.steamId).toBe('76561198000000002');
      expect(result.ownerSteamId).toBe('76561198000000003');
      expect(result.vacBanned).toBe(true);
    }
  });

  it('returns a rejection when Steam returns an error body', async () => {
    const client = createSteamWebClient({
      host: HOST,
      publisherKey: KEY,
      timeoutMs: 500,
      fetch: () =>
        Promise.resolve(
          jsonResponse({
            response: { error: { errorcode: 3, errordesc: 'Invalid ticket' } },
          }),
        ),
    });
    const result = await client.authenticateTicket({
      appId: APP.app_id,
      ticket: 'ff',
      identity: IDENTITY,
    });
    expect(result).toEqual({ status: 'rejected', errorcode: 3, errordesc: 'Invalid ticket' });
  });

  it('throws a SteamApiError when the Web API returns a non-2xx', async () => {
    const client = createSteamWebClient({
      host: HOST,
      publisherKey: KEY,
      timeoutMs: 500,
      fetch: () => Promise.resolve(new Response('nope', { status: 500 })),
    });
    await expect(
      client.authenticateTicket({ appId: APP.app_id, ticket: 'ff', identity: IDENTITY }),
    ).rejects.toBeInstanceOf(SteamApiError);
  });

  it('sends key, steamid and appid when checking ownership', async () => {
    const seen: URL[] = [];
    const client = createSteamWebClient({
      host: HOST,
      publisherKey: KEY,
      timeoutMs: 500,
      fetch: (input) => {
        const url = typeof input === 'string' ? new URL(input) : new URL((input as URL).toString());
        seen.push(url);
        return Promise.resolve(
          jsonResponse({
            response: {
              appownership: {
                ownsapp: true,
                permanent: true,
                ownersteamid: '76561198000000001',
              },
            },
          }),
        );
      },
    });
    const result = await client.checkAppOwnership({
      steamId: '76561198000000001',
      appId: APP.app_id,
    });
    expect(seen[0]?.pathname).toBe(STEAM_CHECK_OWNERSHIP_PATH);
    expect(seen[0]?.searchParams.get('key')).toBe(KEY);
    expect(seen[0]?.searchParams.get('steamid')).toBe('76561198000000001');
    expect(seen[0]?.searchParams.get('appid')).toBe(String(APP.app_id));
    expect(result).toEqual({
      status: 'ok',
      ownsApp: true,
      permanent: true,
      ownerSteamId: '76561198000000001',
    });
  });
});

describe('familySharingAllows', () => {
  it('always allows a ticket where the owner is the player', () => {
    for (const policy of ['allow', 'deny', 'allow_no_entitlement'] as const) {
      expect(familySharingAllows(policy, { familyShared: false })).toEqual({
        allowed: true,
        grantEntitlement: true,
      });
    }
  });

  it('rejects family-shared tickets under deny', () => {
    expect(familySharingAllows('deny', { familyShared: true })).toEqual({
      allowed: false,
      grantEntitlement: false,
    });
  });

  it('trusts the owner under allow', () => {
    expect(familySharingAllows('allow', { familyShared: true })).toEqual({
      allowed: true,
      grantEntitlement: true,
    });
  });

  it('lets the player in without granting under allow_no_entitlement', () => {
    expect(familySharingAllows('allow_no_entitlement', { familyShared: true })).toEqual({
      allowed: true,
      grantEntitlement: false,
    });
  });
});

describe('findSteamApp', () => {
  it('returns the app matching the id, or undefined', () => {
    expect(findSteamApp([APP], APP.app_id)).toBe(APP);
    expect(findSteamApp([APP], 42)).toBeUndefined();
  });
});
