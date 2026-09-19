import { createHash, createPublicKey, type KeyObject, sign, verify } from 'node:crypto';

import type { SigningAlgorithm } from '@qtiauth/keys';

export const ACCESS_TOKEN_TYPE = 'at+jwt';
export const ID_TOKEN_TYPE = 'JWT';

export interface JwtHeader {
  alg: SigningAlgorithm;
  typ: string;
  kid: string;
}

export type JwtPayload = Record<string, unknown>;

export interface SignJwtOptions {
  header: JwtHeader;
  payload: JwtPayload;
  privateKey: KeyObject;
}

function encodeSegment(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decodeSegment(segment: string): unknown {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) return undefined;
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function signBytes(alg: SigningAlgorithm, input: Buffer, key: KeyObject): Buffer {
  if (alg === 'EdDSA') return sign(null, input, key);
  if (alg === 'ES256') return sign('sha256', input, { key, dsaEncoding: 'ieee-p1363' });
  return sign('sha256', input, key);
}

function verifyBytes(
  alg: SigningAlgorithm,
  input: Buffer,
  key: KeyObject,
  signature: Buffer,
): boolean {
  try {
    if (alg === 'EdDSA') return verify(null, input, key, signature);
    if (alg === 'ES256') {
      return verify('sha256', input, { key, dsaEncoding: 'ieee-p1363' }, signature);
    }
    return verify('sha256', input, key, signature);
  } catch {
    return false;
  }
}

export function signJwt(options: SignJwtOptions): string {
  const signingInput = `${encodeSegment(options.header)}.${encodeSegment(options.payload)}`;
  const signature = signBytes(options.header.alg, Buffer.from(signingInput), options.privateKey);
  return `${signingInput}.${signature.toString('base64url')}`;
}

export function atHash(accessToken: string, alg: SigningAlgorithm): string {
  const hash = createHash(alg === 'EdDSA' ? 'sha512' : 'sha256')
    .update(accessToken)
    .digest();
  return hash.subarray(0, hash.length / 2).toString('base64url');
}

export interface VerifiedJwt {
  header: JwtHeader;
  payload: JwtPayload;
}

export function verifyJwt(
  token: string,
  options: {
    algorithm: SigningAlgorithm;
    typ: string;
    issuer: string;
    audience: string;
    getKey: (kid: string) => KeyObject | undefined;
    now?: Date;
    clockToleranceMs?: number;
  },
): VerifiedJwt | undefined {
  const parts = token.split('.');
  if (
    parts.length !== 3 ||
    parts[0] === undefined ||
    parts[1] === undefined ||
    parts[2] === undefined
  ) {
    return undefined;
  }
  const header = decodeSegment(parts[0]) as JwtHeader | undefined;
  const payload = decodeSegment(parts[1]) as JwtPayload | undefined;
  if (
    header === undefined ||
    payload === undefined ||
    header.alg !== options.algorithm ||
    header.typ !== options.typ ||
    typeof header.kid !== 'string' ||
    header.kid === ''
  ) {
    return undefined;
  }
  const key = options.getKey(header.kid);
  if (!key) return undefined;
  if (!/^[A-Za-z0-9_-]+$/.test(parts[2])) return undefined;
  const signature = Buffer.from(parts[2], 'base64url');
  if (!verifyBytes(header.alg, Buffer.from(`${parts[0]}.${parts[1]}`), key, signature)) {
    return undefined;
  }
  if (payload['iss'] !== options.issuer) return undefined;
  const aud = payload['aud'];
  const audiences = Array.isArray(aud) ? aud : [aud];
  if (!audiences.includes(options.audience)) return undefined;
  const now = (options.now ?? new Date()).getTime();
  const tolerance = options.clockToleranceMs ?? 0;
  const exp = payload['exp'];
  const nbf = payload['nbf'];
  if (typeof exp === 'number' && exp * 1000 + tolerance <= now) return undefined;
  if (typeof nbf === 'number' && nbf * 1000 - tolerance > now) return undefined;
  return { header, payload };
}

export function publicKeyFromJwk(jwk: object): KeyObject | undefined {
  try {
    return createPublicKey({ key: jwk, format: 'jwk' });
  } catch {
    return undefined;
  }
}
