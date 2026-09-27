import type { SteamFamilySharingPolicy } from '@qtiauth/config';

export const STEAM_AUTHENTICATE_PATH = '/ISteamUserAuth/AuthenticateUserTicket/v1/';
export const STEAM_CHECK_OWNERSHIP_PATH = '/ISteamUser/CheckAppOwnership/v4/';

export const STEAMID_PATTERN = /^\d{17}$/;

export interface SteamAppSettings {
  app_id: number;
  game_slug: string;
  ticket_identity: string;
  family_sharing: SteamFamilySharingPolicy;
  sync_ownership: boolean;
}

export interface SteamWebClientOptions {
  host: string;
  publisherKey: string;
  timeoutMs: number;
  fetch?: typeof fetch;
}

export interface AuthenticateTicketOptions {
  appId: number;
  ticket: string;
  identity: string;
}

export interface AuthenticateTicketOk {
  status: 'ok';
  steamId: string;
  ownerSteamId: string;
  vacBanned: boolean;
  publisherBanned: boolean;
}

export interface AuthenticateTicketRejected {
  status: 'rejected';
  errorcode: number | null;
  errordesc: string | null;
}

export type AuthenticateTicketResult = AuthenticateTicketOk | AuthenticateTicketRejected;

export interface CheckOwnershipResult {
  status: 'ok';
  ownsApp: boolean;
  permanent: boolean;
  ownerSteamId: string;
}

export class SteamApiError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'SteamApiError';
  }
}

export interface SteamWebClient {
  authenticateTicket: (options: AuthenticateTicketOptions) => Promise<AuthenticateTicketResult>;
  checkAppOwnership: (options: { steamId: string; appId: number }) => Promise<CheckOwnershipResult>;
}

function isSteamId(value: unknown): value is string {
  return typeof value === 'string' && STEAMID_PATTERN.test(value);
}

function readParams(record: Record<string, unknown>): {
  result: string | undefined;
  steamId: string | undefined;
  ownerSteamId: string | undefined;
  vacBanned: boolean;
  publisherBanned: boolean;
  errorcode: number | null;
  errordesc: string | null;
} {
  const rawResult = record['result'];
  const rawSteamId = record['steamid'];
  const rawOwnerSteamId = record['ownersteamid'];
  const rawErrorcode = record['errorcode'];
  const rawErrordesc = record['errordesc'];
  const result = typeof rawResult === 'string' ? rawResult : undefined;
  const steamId = isSteamId(rawSteamId) ? rawSteamId : undefined;
  const ownerSteamId = isSteamId(rawOwnerSteamId) ? rawOwnerSteamId : steamId;
  const vacBanned = record['vacbanned'] === true;
  const publisherBanned = record['publisherbanned'] === true;
  const errorcode = typeof rawErrorcode === 'number' ? rawErrorcode : null;
  const errordesc = typeof rawErrordesc === 'string' ? rawErrordesc : null;
  return { result, steamId, ownerSteamId, vacBanned, publisherBanned, errorcode, errordesc };
}

async function callSteam(
  options: SteamWebClientOptions,
  path: string,
  query: URLSearchParams,
): Promise<Record<string, unknown>> {
  const url = new URL(path, `https://${options.host}`);
  for (const [key, value] of query) url.searchParams.append(key, value);
  const doFetch = options.fetch ?? fetch;
  const response = await doFetch(url, {
    method: 'GET',
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  if (!response.ok) {
    throw new SteamApiError('upstream_status', `Steam Web API returned ${String(response.status)}`);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new SteamApiError('invalid_response', 'Steam Web API returned a body that is not JSON');
  }
  if (payload === null || typeof payload !== 'object') {
    throw new SteamApiError('invalid_response', 'Steam Web API returned an unexpected body');
  }
  const record = (payload as { response?: unknown }).response;
  if (record === null || typeof record !== 'object') {
    throw new SteamApiError('invalid_response', 'Steam Web API returned an unexpected body');
  }
  return record as Record<string, unknown>;
}

export function createSteamWebClient(options: SteamWebClientOptions): SteamWebClient {
  return {
    authenticateTicket: async ({ appId, ticket, identity }) => {
      const query = new URLSearchParams({
        key: options.publisherKey,
        appid: String(appId),
        ticket,
        identity,
      });
      const response = await callSteam(options, STEAM_AUTHENTICATE_PATH, query);
      const params = (response as { params?: unknown; error?: unknown }).params;
      if (params && typeof params === 'object') {
        const parsed = readParams(params as Record<string, unknown>);
        if (parsed.result === 'OK' && parsed.steamId !== undefined) {
          return {
            status: 'ok' as const,
            steamId: parsed.steamId,
            ownerSteamId: parsed.ownerSteamId ?? parsed.steamId,
            vacBanned: parsed.vacBanned,
            publisherBanned: parsed.publisherBanned,
          };
        }
      }
      const error = (response as { error?: unknown }).error;
      const errorRecord =
        error !== undefined && error !== null && typeof error === 'object'
          ? (error as Record<string, unknown>)
          : {};
      const rawCode = errorRecord['errorcode'];
      const rawDesc = errorRecord['errordesc'];
      const errorcode = typeof rawCode === 'number' ? rawCode : null;
      const errordesc = typeof rawDesc === 'string' ? rawDesc : null;
      return { status: 'rejected' as const, errorcode, errordesc };
    },
    checkAppOwnership: async ({ steamId, appId }) => {
      const query = new URLSearchParams({
        key: options.publisherKey,
        steamid: steamId,
        appid: String(appId),
      });
      const response = await callSteam(options, STEAM_CHECK_OWNERSHIP_PATH, query);
      const appOwnership = (response as { appownership?: unknown }).appownership;
      if (!appOwnership || typeof appOwnership !== 'object') {
        throw new SteamApiError(
          'invalid_response',
          'Steam Web API returned an unexpected ownership body',
        );
      }
      const record = appOwnership as Record<string, unknown>;
      const ownsApp = record['ownsapp'] === true;
      const permanent = record['permanent'] === true;
      const rawOwner = record['ownersteamid'];
      const ownerSteamId = isSteamId(rawOwner) ? rawOwner : steamId;
      return { status: 'ok' as const, ownsApp, permanent, ownerSteamId };
    },
  };
}

export function familySharingAllows(
  policy: SteamFamilySharingPolicy,
  options: { familyShared: boolean },
): { allowed: boolean; grantEntitlement: boolean } {
  if (!options.familyShared) return { allowed: true, grantEntitlement: true };
  switch (policy) {
    case 'allow':
      return { allowed: true, grantEntitlement: true };
    case 'deny':
      return { allowed: false, grantEntitlement: false };
    case 'allow_no_entitlement':
      return { allowed: true, grantEntitlement: false };
  }
}

export function findSteamApp(
  apps: readonly SteamAppSettings[],
  appId: number,
): SteamAppSettings | undefined {
  return apps.find((app) => app.app_id === appId);
}
