import { OAUTH_TIMEOUT_MS } from './oauth.ts';

export const STEAM_OPENID_URL = 'https://steamcommunity.com/openid/login';
export const STEAM_CLAIMED_ID = /^https?:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/i;

export function steamAuthorizationUrl(options: { realm: string; returnTo: string }): string {
  const url = new URL(STEAM_OPENID_URL);
  url.searchParams.set('openid.ns', 'http://specs.openid.net/auth/2.0');
  url.searchParams.set('openid.mode', 'checkid_setup');
  url.searchParams.set('openid.return_to', options.returnTo);
  url.searchParams.set('openid.realm', options.realm);
  url.searchParams.set('openid.identity', 'http://specs.openid.net/auth/2.0/identifier_select');
  url.searchParams.set('openid.claimed_id', 'http://specs.openid.net/auth/2.0/identifier_select');
  return url.toString();
}

export function steamIdFromClaimedId(claimedId: string): string | undefined {
  return STEAM_CLAIMED_ID.exec(claimedId)?.[1];
}

export function steamReturnTo(redirectUri: string, state: string): string {
  const url = new URL(redirectUri);
  url.searchParams.set('state', state);
  return url.toString();
}

export async function verifySteamAssertion(
  params: URLSearchParams,
  options: {
    redirectUri: string;
    state: string;
    fetch: typeof fetch;
    timeoutMs?: number;
  },
): Promise<string | undefined> {
  if (params.get('openid.mode') !== 'id_res') return undefined;
  const claimedId = params.get('openid.claimed_id') ?? '';
  const steamId = steamIdFromClaimedId(claimedId);
  if (steamId === undefined) return undefined;
  const identity = params.get('openid.identity') ?? claimedId;
  if (steamIdFromClaimedId(identity) !== steamId) return undefined;
  const returnTo = params.get('openid.return_to') ?? '';
  let parsed: URL;
  try {
    parsed = new URL(returnTo);
  } catch {
    return undefined;
  }
  const expected = new URL(options.redirectUri);
  if (parsed.origin !== expected.origin || parsed.pathname !== expected.pathname) return undefined;
  if (parsed.searchParams.get('state') !== options.state) return undefined;

  const body = new URLSearchParams(params);
  body.set('openid.mode', 'check_authentication');
  const response = await options.fetch(STEAM_OPENID_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(options.timeoutMs ?? OAUTH_TIMEOUT_MS),
  });
  if (!response.ok) return undefined;
  const text = await response.text();
  if (!/(?:^|\n)is_valid:true(?:\r?\n|$)/.test(text)) return undefined;
  return steamId;
}
