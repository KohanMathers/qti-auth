import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function newEventId(now: number = Date.now()): string {
  let time = '';
  for (let rest = now, i = 0; i < 10; i++, rest = Math.floor(rest / 32)) {
    time = ALPHABET.charAt(rest % 32) + time;
  }
  let random = '';
  for (const byte of randomBytes(16)) random += ALPHABET.charAt(byte % 32);
  return time + random;
}
