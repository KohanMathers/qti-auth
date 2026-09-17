import { argon2 as argon2Callback, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const argon2 = promisify(argon2Callback);

export const PASSWORD_METHOD = 'password';
export const PASSWORD_AMR = ['pwd'];
export const PASSWORD_MAX_LENGTH = 256;
export const HIBP_RANGE_URL = 'https://api.pwnedpasswords.com/range/';
export const HIBP_TIMEOUT_MS = 2_000;

const SALT_LENGTH = 16;
const HASH_LENGTH = 32;
const ARGON2_VERSION = 19;
const PHC = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;
const LOCAL_PART_MIN = 3;

export interface Argon2Params {
  memoryKib: number;
  iterations: number;
  parallelism: number;
}

export interface PasswordPolicy {
  minLength: number;
  maxLength: number;
  requireLower: boolean;
  requireUpper: boolean;
  requireDigit: boolean;
  requireSymbol: boolean;
}

export type PasswordPolicyReason =
  | 'too_short'
  | 'too_long'
  | 'need_lower'
  | 'need_upper'
  | 'need_digit'
  | 'need_symbol'
  | 'contains_identifier'
  | 'breached';

export type BreachCheckResult = 'rejected' | 'passed' | 'unavailable';

let dummy: { key: string; hash: string } | undefined;

function phcEncode(buffer: Buffer): string {
  return buffer.toString('base64').replace(/=+$/, '');
}

function phcDecode(value: string): Buffer {
  return Buffer.from(value + '='.repeat((4 - (value.length % 4)) % 4), 'base64');
}

function paramsKey(params: Argon2Params): string {
  return `${String(params.memoryKib)}:${String(params.iterations)}:${String(params.parallelism)}`;
}

async function derive(password: string, salt: Buffer, params: Argon2Params): Promise<Buffer> {
  return argon2('argon2id', {
    message: password,
    nonce: salt,
    parallelism: params.parallelism,
    tagLength: HASH_LENGTH,
    memory: params.memoryKib,
    passes: params.iterations,
  });
}

export function encodePasswordHash(salt: Buffer, hash: Buffer, params: Argon2Params): string {
  return `$argon2id$v=${String(ARGON2_VERSION)}$m=${String(params.memoryKib)},t=${String(params.iterations)},p=${String(params.parallelism)}$${phcEncode(salt)}$${phcEncode(hash)}`;
}

export function parsePasswordHash(
  encoded: string,
): { salt: Buffer; hash: Buffer; params: Argon2Params } | undefined {
  const match = PHC.exec(encoded);
  if (!match) return undefined;
  const [, memory, iterations, parallelism, salt, hash] = match;
  if (
    memory === undefined ||
    iterations === undefined ||
    parallelism === undefined ||
    salt === undefined ||
    hash === undefined
  ) {
    return undefined;
  }
  const saltBuf = phcDecode(salt);
  const hashBuf = phcDecode(hash);
  if (saltBuf.length === 0 || hashBuf.length === 0) return undefined;
  return {
    salt: saltBuf,
    hash: hashBuf,
    params: {
      memoryKib: Number(memory),
      iterations: Number(iterations),
      parallelism: Number(parallelism),
    },
  };
}

export function needsRehash(encoded: string, params: Argon2Params): boolean {
  const parsed = parsePasswordHash(encoded);
  if (!parsed) return true;
  return (
    parsed.params.memoryKib !== params.memoryKib ||
    parsed.params.iterations !== params.iterations ||
    parsed.params.parallelism !== params.parallelism
  );
}

export async function hashPassword(password: string, params: Argon2Params): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const hash = await derive(password, salt, params);
  return encodePasswordHash(salt, hash, params);
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parsed = parsePasswordHash(encoded);
  if (!parsed) return false;
  const actual = await derive(password, parsed.salt, parsed.params);
  if (actual.length !== parsed.hash.length) return false;
  return timingSafeEqual(actual, parsed.hash);
}

export async function dummyPasswordHash(params: Argon2Params): Promise<string> {
  const key = paramsKey(params);
  if (dummy?.key === key) return dummy.hash;
  const hash = await hashPassword(randomBytes(32).toString('base64url'), params);
  dummy = { key, hash };
  return hash;
}

export function emailLocalPart(email: string): string {
  const trimmed = email.trim();
  const at = trimmed.lastIndexOf('@');
  return at === -1 ? trimmed : trimmed.slice(0, at);
}

export function passwordContainsIdentifier(
  password: string,
  identifiers: readonly (string | null | undefined)[],
): boolean {
  const haystack = password.toLowerCase();
  for (const identifier of identifiers) {
    if (identifier === null || identifier === undefined) continue;
    const needle = identifier.trim().toLowerCase();
    if (needle.length >= LOCAL_PART_MIN && haystack.includes(needle)) return true;
  }
  return false;
}

export function passwordPolicyReason(
  password: string,
  policy: PasswordPolicy,
  identifiers: readonly (string | null | undefined)[],
): Exclude<PasswordPolicyReason, 'breached'> | undefined {
  if (password.length < policy.minLength) return 'too_short';
  if (password.length > policy.maxLength) return 'too_long';
  if (policy.requireLower && !/[a-z]/.test(password)) return 'need_lower';
  if (policy.requireUpper && !/[A-Z]/.test(password)) return 'need_upper';
  if (policy.requireDigit && !/\d/.test(password)) return 'need_digit';
  if (policy.requireSymbol && !/[^A-Za-z0-9]/.test(password)) return 'need_symbol';
  if (passwordContainsIdentifier(password, identifiers)) return 'contains_identifier';
  return undefined;
}

export async function checkBreachedPassword(
  password: string,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<BreachCheckResult> {
  const sha1 = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);
  const fetchImpl = options.fetch ?? fetch;
  const timeout = options.timeoutMs ?? HIBP_TIMEOUT_MS;
  try {
    const response = await fetchImpl(`${HIBP_RANGE_URL}${prefix}`, {
      headers: { 'user-agent': 'QTIAuth', 'add-padding': 'true' },
      signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok) return 'unavailable';
    const body = await response.text();
    for (const line of body.split('\n')) {
      const [hash = '', count = ''] = line.trim().split(':');
      if (hash.toUpperCase() === suffix && Number(count) > 0) return 'rejected';
    }
    return 'passed';
  } catch {
    return 'unavailable';
  }
}
