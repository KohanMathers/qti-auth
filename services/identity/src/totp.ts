import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const TOTP_METHOD = 'totp';
export const TOTP_AMR = ['otp'];
export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_WINDOW = 1;
export const TOTP_SECRET_BYTES = 20;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function randomTotpSecret(): Buffer {
  return randomBytes(TOTP_SECRET_BYTES);
}

export function encodeBase32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31] ?? '';
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31] ?? '';
  return output;
}

export function decodeBase32(value: string): Buffer | undefined {
  const cleaned = value.trim().toUpperCase().replace(/[=\s]/g, '');
  if (cleaned.length === 0 || /[^A-Z2-7]/.test(cleaned)) return undefined;
  let bits = 0;
  let acc = 0;
  const bytes: number[] = [];
  for (const char of cleaned) {
    const index = BASE32.indexOf(char);
    if (index === -1) return undefined;
    acc = (acc << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((acc >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function totpCode(secret: Buffer, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeUInt32BE(Math.floor(counter / 0x1_0000_0000), 0);
  msg.writeUInt32BE(counter >>> 0, 4);
  const hmac = createHmac('sha1', secret).update(msg).digest();
  const offset = (hmac.at(-1) ?? 0) & 15;
  const binary =
    (((hmac[offset] ?? 0) & 127) << 24) |
    (((hmac[offset + 1] ?? 0) & 255) << 16) |
    (((hmac[offset + 2] ?? 0) & 255) << 8) |
    ((hmac[offset + 3] ?? 0) & 255);
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

export function totpAt(secret: Buffer, at: Date): string {
  return totpCode(secret, Math.floor(at.getTime() / 1000 / TOTP_PERIOD_SECONDS));
}

export function verifyTotp(secret: Buffer, code: string, at: Date): boolean {
  const cleaned = code.trim().replace(/\s/g, '');
  if (!/^\d{6}$/.test(cleaned)) return false;
  const presented = Buffer.from(cleaned);
  const counter = Math.floor(at.getTime() / 1000 / TOTP_PERIOD_SECONDS);
  for (let delta = -TOTP_WINDOW; delta <= TOTP_WINDOW; delta++) {
    const expected = Buffer.from(totpCode(secret, counter + delta));
    if (expected.length === presented.length && timingSafeEqual(expected, presented)) return true;
  }
  return false;
}

export function otpauthUri(options: { issuer: string; account: string; secret: Buffer }): string {
  const issuer = encodeURIComponent(options.issuer);
  const account = encodeURIComponent(options.account);
  const secret = encodeBase32(options.secret);
  return `otpauth://totp/${issuer}:${account}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=${String(TOTP_DIGITS)}&period=${String(TOTP_PERIOD_SECONDS)}`;
}
