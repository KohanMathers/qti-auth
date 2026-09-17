import { createPublicKey, type KeyObject, randomUUID, sign, verify } from 'node:crypto';

import * as z from 'zod';

export const IDENTITY_HEADER = 'X-QTIAuth-Identity';
export const IDENTITY_ISSUER = 'qtiauth-gateway';
export const IDENTITY_TOKEN_TYPE = 'qtiauth-identity+jwt';
export const IDENTITY_TOKEN_LIFETIME = 60;

export const AUTH_MODES = ['none', 'session', 'oauth', 'service', 'game_authoritative'] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

export const ACCOUNT_STATES = [
  'pending_email_verification',
  'pending_parental_consent',
  'active',
  'locked',
  'banned',
  'pending_deletion',
  'deleted',
] as const;
export type AccountState = (typeof ACCOUNT_STATES)[number];

export const AGE_BANDS = ['under_13', '13_to_15', '16_to_17', 'adult'] as const;
export type AgeBand = (typeof AGE_BANDS)[number];

export const parentalControlsSchema = z.strictObject({
  online_play: z.boolean(),
  in_game_chat: z.boolean(),
  user_generated_content: z.boolean(),
  purchases: z.boolean(),
  daily_playtime_minutes: z.int().min(0).nullable(),
});

export const identityClaimsSchema = z.strictObject({
  iss: z.literal(IDENTITY_ISSUER),
  aud: z.string().min(1),
  iat: z.int(),
  exp: z.int(),
  jti: z.string().min(1),
  request_id: z.string().min(1),
  auth: z.enum(AUTH_MODES),
  sub: z.string().min(1).nullable(),
  sid: z.string().min(1).nullable(),
  client_id: z.string().min(1).nullable(),
  scopes: z.array(z.string().min(1)),
  permissions: z.array(z.string().min(1)),
  account_state: z.enum(ACCOUNT_STATES).nullable(),
  restrictions: z.array(z.string().min(1)),
  age_band: z.enum(AGE_BANDS).nullable(),
  parental_controls: parentalControlsSchema.nullable(),
  amr: z.array(z.string().min(1)),
  acr: z.string().min(1).nullable(),
});

export type IdentityClaims = z.output<typeof identityClaimsSchema>;
export type ParentalControls = z.output<typeof parentalControlsSchema>;
export type Identity = Omit<IdentityClaims, 'iss' | 'aud' | 'iat' | 'exp' | 'jti'>;

export type IdentityTokenFailure =
  | 'missing'
  | 'malformed'
  | 'unsupported_algorithm'
  | 'unknown_key'
  | 'bad_signature'
  | 'invalid_claims'
  | 'wrong_audience'
  | 'expired'
  | 'not_yet_valid'
  | 'lifetime_too_long'
  | 'keys_unavailable';

export class IdentityTokenError extends Error {
  readonly reason: IdentityTokenFailure;

  constructor(reason: IdentityTokenFailure, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'IdentityTokenError';
    this.reason = reason;
  }
}

export interface IdentityKeySource {
  get: (kid: string) => Promise<KeyObject | undefined>;
}

export interface PublicJwk {
  kty?: string;
  crv?: string;
  x?: string;
  kid?: string;
  alg?: string;
  use?: string;
  d?: string;
}

export interface JsonWebKeySet {
  keys: PublicJwk[];
}

export interface SigningKey {
  kid: string;
  privateKey: KeyObject;
}

export interface SignOptions {
  audience: string;
  key: SigningKey;
  now?: Date;
  lifetime?: number;
}

export interface VerifyOptions {
  audience: string;
  keys: IdentityKeySource;
  clockTolerance: number;
  now?: Date;
}

const headerSchema = z.object({
  alg: z.string(),
  typ: z.string().optional(),
  kid: z.string().min(1),
});

function encodeSegment(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decodeSegment(segment: string): unknown {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) {
    throw new IdentityTokenError('malformed', 'Token segment is not base64url');
  }
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch (error) {
    throw new IdentityTokenError('malformed', 'Token segment is not JSON', { cause: error });
  }
}

export function publicKeyFromJwk(jwk: PublicJwk): KeyObject {
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string' || 'd' in jwk) {
    throw new IdentityTokenError('keys_unavailable', 'Identity keys must be Ed25519 public JWKs');
  }
  return createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, format: 'jwk' });
}

export function signIdentityToken(identity: Identity, options: SignOptions): string {
  const iat = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const claims: IdentityClaims = {
    ...identity,
    iss: IDENTITY_ISSUER,
    aud: options.audience,
    iat,
    exp: iat + (options.lifetime ?? IDENTITY_TOKEN_LIFETIME),
    jti: randomUUID(),
  };
  const signingInput = `${encodeSegment({ alg: 'EdDSA', typ: IDENTITY_TOKEN_TYPE, kid: options.key.kid })}.${encodeSegment(identityClaimsSchema.parse(claims))}`;
  const signature = sign(null, Buffer.from(signingInput), options.key.privateKey);
  return `${signingInput}.${signature.toString('base64url')}`;
}

export async function verifyIdentityToken(
  token: string | undefined,
  options: VerifyOptions,
): Promise<IdentityClaims> {
  if (token === undefined || token === '') {
    throw new IdentityTokenError('missing', `Missing ${IDENTITY_HEADER} header`);
  }
  const segments = token.split('.');
  const [headerSegment = '', payloadSegment = '', signatureSegment = ''] = segments;
  if (segments.length !== 3) {
    throw new IdentityTokenError('malformed', 'Token must have three segments');
  }

  const header = headerSchema.safeParse(decodeSegment(headerSegment));
  if (!header.success) {
    throw new IdentityTokenError('malformed', 'Token header needs alg and kid');
  }
  if (header.data.alg !== 'EdDSA' || header.data.typ !== IDENTITY_TOKEN_TYPE) {
    throw new IdentityTokenError('unsupported_algorithm', 'Token must be an EdDSA identity token');
  }

  const key = await options.keys.get(header.data.kid);
  if (!key) {
    throw new IdentityTokenError('unknown_key', 'Token was signed with an unknown key');
  }
  if (!/^[A-Za-z0-9_-]+$/.test(signatureSegment)) {
    throw new IdentityTokenError('malformed', 'Token signature is not base64url');
  }
  const valid = verify(
    null,
    Buffer.from(`${headerSegment}.${payloadSegment}`),
    key,
    Buffer.from(signatureSegment, 'base64url'),
  );
  if (!valid) {
    throw new IdentityTokenError('bad_signature', 'Token signature does not match');
  }

  const parsed = identityClaimsSchema.safeParse(decodeSegment(payloadSegment));
  if (!parsed.success) {
    throw new IdentityTokenError('invalid_claims', 'Token claims are not valid');
  }
  const claims = parsed.data;
  const now = (options.now ?? new Date()).getTime() / 1000;
  const tolerance = options.clockTolerance / 1000;
  if (claims.aud !== options.audience) {
    throw new IdentityTokenError('wrong_audience', 'Token was minted for another service');
  }
  if (claims.exp - claims.iat > IDENTITY_TOKEN_LIFETIME) {
    throw new IdentityTokenError('lifetime_too_long', 'Token lifetime is too long');
  }
  if (claims.exp + tolerance <= now) {
    throw new IdentityTokenError('expired', 'Token has expired');
  }
  if (claims.iat - tolerance > now) {
    throw new IdentityTokenError('not_yet_valid', 'Token was issued in the future');
  }
  return claims;
}

export function identityFromClaims(claims: IdentityClaims): Identity {
  return {
    request_id: claims.request_id,
    auth: claims.auth,
    sub: claims.sub,
    sid: claims.sid,
    client_id: claims.client_id,
    scopes: claims.scopes,
    permissions: claims.permissions,
    account_state: claims.account_state,
    restrictions: claims.restrictions,
    age_band: claims.age_band,
    parental_controls: claims.parental_controls,
    amr: claims.amr,
    acr: claims.acr,
  };
}
