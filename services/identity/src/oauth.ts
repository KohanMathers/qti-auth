import { createHash, randomBytes } from 'node:crypto';

import type { Jwk, JwtClaims } from './jwt.ts';
import { verifyIdToken } from './jwt.ts';
import type { SocialProvider } from './providers.ts';

export const OAUTH_TIMEOUT_MS = 10_000;

export interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
  jwks_uri: string;
}

export interface SocialProfile {
  subject: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  birthdate: string | null;
}

export interface TokenSet {
  accessToken: string;
  idToken: string | null;
  tokenType: string;
}

const discoveryCache = new Map<string, { discovery: OidcDiscovery; expiresAt: number }>();
const DISCOVERY_TTL = 60 * 60_000;

export function pkceVerifier(): string {
  return randomBytes(32).toString('base64url');
}

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function authorizationUrl(
  provider: SocialProvider,
  options: {
    discovery?: OidcDiscovery | undefined;
    redirectUri: string;
    state: string;
    codeChallenge: string | null;
    nonce: string | null;
  },
): string {
  const endpoint = provider.authorizationEndpoint ?? options.discovery?.authorization_endpoint;
  if (endpoint === undefined) throw new Error(`No authorization endpoint for ${provider.id}`);
  const url = new URL(endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', provider.clientId);
  url.searchParams.set('redirect_uri', options.redirectUri);
  url.searchParams.set('state', options.state);
  url.searchParams.set('scope', provider.scopes.join(' '));
  if (options.codeChallenge !== null) {
    url.searchParams.set('code_challenge', options.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
  }
  if (options.nonce !== null) url.searchParams.set('nonce', options.nonce);
  return url.toString();
}

export async function discoverIssuer(
  issuer: string,
  fetchImpl: typeof fetch,
  timeoutMs = OAUTH_TIMEOUT_MS,
  now = Date.now(),
): Promise<OidcDiscovery> {
  const cached = discoveryCache.get(issuer);
  if (cached !== undefined && cached.expiresAt > now) return cached.discovery;
  const base = issuer.endsWith('/') ? issuer : `${issuer}/`;
  const response = await fetchImpl(new URL('.well-known/openid-configuration', base), {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error('OIDC discovery failed');
  const body = (await response.json()) as Partial<OidcDiscovery>;
  if (
    typeof body.issuer !== 'string' ||
    typeof body.authorization_endpoint !== 'string' ||
    typeof body.token_endpoint !== 'string' ||
    typeof body.jwks_uri !== 'string'
  ) {
    throw new Error('OIDC discovery document is incomplete');
  }
  const discovery: OidcDiscovery = {
    issuer: body.issuer,
    authorization_endpoint: body.authorization_endpoint,
    token_endpoint: body.token_endpoint,
    jwks_uri: body.jwks_uri,
    ...(typeof body.userinfo_endpoint === 'string'
      ? { userinfo_endpoint: body.userinfo_endpoint }
      : {}),
  };
  discoveryCache.set(issuer, { discovery, expiresAt: now + DISCOVERY_TTL });
  return discovery;
}

export function clearDiscoveryCache(): void {
  discoveryCache.clear();
}

export async function exchangeAuthorizationCode(
  provider: SocialProvider,
  options: {
    code: string;
    redirectUri: string;
    codeVerifier: string | null;
    discovery?: OidcDiscovery | undefined;
    fetch: typeof fetch;
    timeoutMs?: number | undefined;
  },
): Promise<TokenSet> {
  const endpoint = provider.tokenEndpoint ?? options.discovery?.token_endpoint;
  if (endpoint === undefined) throw new Error(`No token endpoint for ${provider.id}`);
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: options.code,
    redirect_uri: options.redirectUri,
    client_id: provider.clientId,
    client_secret: provider.clientSecret,
  });
  if (options.codeVerifier !== null) body.set('code_verifier', options.codeVerifier);
  const response = await options.fetch(endpoint, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
    signal: AbortSignal.timeout(options.timeoutMs ?? OAUTH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error('Token exchange failed');
  const raw = await readTokenBody(response);
  const accessToken = raw['access_token'];
  if (typeof accessToken !== 'string' || accessToken === '')
    throw new Error('Token exchange failed');
  const idToken = raw['id_token'];
  return {
    accessToken,
    idToken: typeof idToken === 'string' && idToken !== '' ? idToken : null,
    tokenType: typeof raw['token_type'] === 'string' ? raw['token_type'] : 'Bearer',
  };
}

async function readTokenBody(response: Response): Promise<Record<string, string>> {
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const json = (await response.json()) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(json).flatMap(([key, value]) =>
        typeof value === 'string' ? [[key, value]] : [],
      ),
    );
  }
  return Object.fromEntries(new URLSearchParams(await response.text()));
}

export async function fetchUserinfo(
  url: string,
  accessToken: string,
  fetchImpl: typeof fetch,
  timeoutMs = OAUTH_TIMEOUT_MS,
): Promise<unknown> {
  const response = await fetchImpl(url, {
    headers: { accept: 'application/json', authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error('Userinfo request failed');
  return response.json();
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export async function fetchJwks(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs = OAUTH_TIMEOUT_MS,
): Promise<Jwk[]> {
  const response = await fetchImpl(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error('JWKS request failed');
  const body = (await response.json()) as { keys?: Jwk[] };
  return body.keys ?? [];
}

function stringClaim(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function verifiedClaim(value: unknown): boolean {
  return value === true || value === 'true';
}

export function profileFromOidc(
  claims: JwtClaims | Record<string, unknown>,
  fallback: Record<string, unknown> = {},
): SocialProfile | undefined {
  const subject = stringClaim(claims.sub) ?? stringClaim(fallback['sub']);
  if (subject === null) return undefined;
  const email = stringClaim(claims.email) ?? stringClaim(fallback['email']);
  const verified =
    verifiedClaim(claims.email_verified) || verifiedClaim(fallback['email_verified']);
  return {
    subject,
    email,
    emailVerified: email !== null && verified,
    name: stringClaim(claims.name) ?? stringClaim(fallback['name']),
    birthdate: stringClaim(claims.birthdate) ?? stringClaim(fallback['birthdate']),
  };
}

export function profileFromDiscord(user: Record<string, unknown>): SocialProfile | undefined {
  const subject = stringClaim(user['id']);
  if (subject === null) return undefined;
  const email = stringClaim(user['email']);
  return {
    subject,
    email,
    emailVerified: email !== null && user['verified'] === true,
    name: stringClaim(user['global_name']) ?? stringClaim(user['username']),
    birthdate: null,
  };
}

export function profileFromGithub(
  user: Record<string, unknown>,
  emails: readonly { email?: string; primary?: boolean; verified?: boolean }[],
): SocialProfile | undefined {
  const id = user['id'];
  const subject = typeof id === 'string' || typeof id === 'number' ? String(id) : null;
  if (subject === null || subject === '') return undefined;
  const primary = emails.find((row) => row.primary === true && row.verified === true);
  const verified = emails.find((row) => row.verified === true);
  const chosen = primary ?? verified;
  return {
    subject,
    email: chosen?.email ?? null,
    emailVerified: chosen?.verified === true && chosen.email !== undefined,
    name: stringClaim(user['name']) ?? stringClaim(user['login']),
    birthdate: null,
  };
}

export async function loadSocialProfile(
  provider: SocialProvider,
  tokens: TokenSet,
  options: {
    discovery?: OidcDiscovery | undefined;
    nonce: string | null;
    fetch: typeof fetch;
    timeoutMs?: number | undefined;
  },
): Promise<SocialProfile> {
  const timeoutMs = options.timeoutMs ?? OAUTH_TIMEOUT_MS;
  if (provider.id === 'github') {
    const user = asRecord(
      await fetchUserinfo(
        provider.userinfoEndpoint ?? GITHUB_USER_FALLBACK,
        tokens.accessToken,
        options.fetch,
        timeoutMs,
      ),
    );
    const emailsUrl = provider.emailsEndpoint;
    const emails =
      emailsUrl === null
        ? []
        : await githubEmails(emailsUrl, tokens.accessToken, options.fetch, timeoutMs);
    const profile = profileFromGithub(user, emails);
    if (profile === undefined) throw new Error('GitHub profile is missing a subject');
    return profile;
  }
  if (provider.id === 'discord') {
    const user = asRecord(
      await fetchUserinfo(
        provider.userinfoEndpoint ?? '',
        tokens.accessToken,
        options.fetch,
        timeoutMs,
      ),
    );
    const profile = profileFromDiscord(user);
    if (profile === undefined) throw new Error('Discord profile is missing a subject');
    return profile;
  }

  let claims: JwtClaims | undefined;
  const issuer = provider.issuer ?? options.discovery?.issuer;
  if (tokens.idToken !== null && options.nonce !== null && issuer !== undefined) {
    const jwksUri = options.discovery?.jwks_uri;
    if (jwksUri === undefined && provider.id !== 'google') {
      throw new Error('OIDC provider did not advertise a JWKS URI');
    }
    const keys =
      jwksUri === undefined
        ? await fetchJwks('https://www.googleapis.com/oauth2/v3/certs', options.fetch, timeoutMs)
        : await fetchJwks(jwksUri, options.fetch, timeoutMs);
    claims = verifyIdToken(tokens.idToken, {
      keys,
      issuer,
      audience: provider.clientId,
      nonce: options.nonce,
    });
    if (claims === undefined) throw new Error('ID token is invalid');
  }

  const userinfoUrl = provider.userinfoEndpoint ?? options.discovery?.userinfo_endpoint;
  const userinfo =
    userinfoUrl === undefined
      ? {}
      : asRecord(await fetchUserinfo(userinfoUrl, tokens.accessToken, options.fetch, timeoutMs));
  const profile = profileFromOidc(claims ?? {}, userinfo);
  if (profile === undefined) throw new Error('OIDC profile is missing a subject');
  return profile;
}

const GITHUB_USER_FALLBACK = 'https://api.github.com/user';

async function githubEmails(
  url: string,
  accessToken: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<{ email?: string; primary?: boolean; verified?: boolean }[]> {
  const body: unknown = await fetchUserinfo(url, accessToken, fetchImpl, timeoutMs);
  if (!Array.isArray(body)) return [];
  return body.flatMap((row) =>
    row !== null && typeof row === 'object'
      ? [row as { email?: string; primary?: boolean; verified?: boolean }]
      : [],
  );
}
