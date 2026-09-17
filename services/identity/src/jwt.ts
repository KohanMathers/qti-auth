import { createPublicKey, createVerify } from 'node:crypto';

const CLOCK_SKEW_MS = 60_000;

export interface JwtClaims {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  iat?: number;
  nonce?: string;
  sub?: string;
  email?: string;
  email_verified?: boolean;
  birthdate?: string;
  name?: string;
  [key: string]: unknown;
}

export interface Jwk {
  kty?: string;
  kid?: string;
  use?: string;
  alg?: string;
  n?: string;
  e?: string;
  crv?: string;
  x?: string;
  y?: string;
}

function decodePart(part: string): unknown {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as unknown;
}

function audienceIncludes(aud: string | string[] | undefined, expected: string): boolean {
  if (aud === undefined) return false;
  return (Array.isArray(aud) ? aud : [aud]).includes(expected);
}

function keyFor(header: { kid?: string; alg?: string }, keys: readonly Jwk[]): Jwk | undefined {
  const byKid = header.kid === undefined ? undefined : keys.find((key) => key.kid === header.kid);
  if (byKid !== undefined) return byKid;
  if (header.kid !== undefined) return undefined;
  return keys.find((key) => key.alg === header.alg || key.alg === undefined);
}

function verifySignature(alg: string, signed: string, signature: Buffer, jwk: Jwk): boolean {
  try {
    const key = createPublicKey({ key: jwk, format: 'jwk' });
    const verifier = createVerify(alg === 'ES256' ? 'SHA256' : 'RSA-SHA256');
    verifier.update(signed);
    verifier.end();
    return verifier.verify(key, signature);
  } catch {
    return false;
  }
}

export function verifyIdToken(
  token: string,
  options: {
    keys: readonly Jwk[];
    issuer: string;
    audience: string;
    nonce: string;
    now?: Date;
  },
): JwtClaims | undefined {
  const parts = token.split('.');
  if (
    parts.length !== 3 ||
    parts[0] === undefined ||
    parts[1] === undefined ||
    parts[2] === undefined
  ) {
    return undefined;
  }
  let header: { alg?: string; kid?: string };
  let payload: JwtClaims;
  try {
    header = decodePart(parts[0]) as { alg?: string; kid?: string };
    payload = decodePart(parts[1]) as JwtClaims;
  } catch {
    return undefined;
  }
  if (header.alg !== 'RS256' && header.alg !== 'ES256') return undefined;
  const jwk = keyFor(header, options.keys);
  if (jwk === undefined) return undefined;
  const signature = Buffer.from(parts[2], 'base64url');
  if (!verifySignature(header.alg, `${parts[0]}.${parts[1]}`, signature, jwk)) return undefined;
  const now = (options.now ?? new Date()).getTime();
  if (payload.exp !== undefined && payload.exp * 1000 + CLOCK_SKEW_MS <= now) return undefined;
  if (payload.nbf !== undefined && payload.nbf * 1000 - CLOCK_SKEW_MS > now) return undefined;
  if (payload.iss !== options.issuer) return undefined;
  if (!audienceIncludes(payload.aud, options.audience)) return undefined;
  if (payload.nonce !== options.nonce) return undefined;
  return payload;
}
