import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

export const ALTCHA_ALGORITHM = 'SHA-256';

export interface AltchaSettings {
  hmacKey: string;
  maxNumber: number;
  expires: number;
}

export interface AltchaChallenge {
  algorithm: typeof ALTCHA_ALGORITHM;
  challenge: string;
  salt: string;
  signature: string;
  maxnumber: number;
}

export interface AltchaPayload extends AltchaChallenge {
  number: number;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sign(hmacKey: string, challenge: string): string {
  return createHmac('sha256', hmacKey).update(challenge).digest('hex');
}

function equalHex(left: string, right: string): boolean {
  const a = Buffer.from(left.toLowerCase());
  const b = Buffer.from(right.toLowerCase());
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createAltchaChallenge(settings: AltchaSettings, now: Date): AltchaChallenge {
  const expires = Math.floor((now.getTime() + settings.expires) / 1000);
  const salt = `${randomBytes(12).toString('hex')}?expires=${String(expires)}`;
  const number = randomInt(0, settings.maxNumber + 1);
  const challenge = sha256(`${salt}${String(number)}`);
  return {
    algorithm: ALTCHA_ALGORITHM,
    challenge,
    salt,
    signature: sign(settings.hmacKey, challenge),
    maxnumber: settings.maxNumber,
  };
}

export function parseAltchaPayload(payload: string): AltchaPayload | undefined {
  // Widgets send the payload as JSON or base64 of that JSON; decoding never
  // throws, so a wrong guess just fails to parse below.
  const texts = [
    payload,
    ...(['base64url', 'base64'] as const).map((encoding) =>
      Buffer.from(payload, encoding).toString('utf8'),
    ),
  ];
  for (const text of texts) {
    try {
      const parsed = JSON.parse(text) as Partial<AltchaPayload>;
      if (
        parsed.algorithm === ALTCHA_ALGORITHM &&
        typeof parsed.challenge === 'string' &&
        typeof parsed.salt === 'string' &&
        typeof parsed.signature === 'string' &&
        typeof parsed.maxnumber === 'number' &&
        typeof parsed.number === 'number'
      ) {
        return parsed as AltchaPayload;
      }
    } catch {
      // not JSON
    }
  }
  return undefined;
}

function expiryMs(salt: string): number | undefined {
  const query = salt.split('?')[1];
  if (query === undefined) return undefined;
  const raw = new URLSearchParams(query).get('expires');
  if (raw === null) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}

export function verifyAltcha(payload: string, settings: AltchaSettings, now: Date): boolean {
  const parsed = parseAltchaPayload(payload);
  if (parsed === undefined) return false;
  if (parsed.maxnumber > settings.maxNumber) return false;
  if (!Number.isInteger(parsed.number) || parsed.number < 0 || parsed.number > parsed.maxnumber) {
    return false;
  }
  if (!equalHex(sign(settings.hmacKey, parsed.challenge), parsed.signature)) return false;
  if (sha256(`${parsed.salt}${String(parsed.number)}`) !== parsed.challenge) return false;
  const expires = expiryMs(parsed.salt);
  return expires === undefined || expires > now.getTime();
}

export function solveAltcha(challenge: AltchaChallenge): string {
  for (let number = 0; number <= challenge.maxnumber; number++) {
    if (sha256(`${challenge.salt}${String(number)}`) === challenge.challenge) {
      return JSON.stringify({ ...challenge, number });
    }
  }
  throw new Error('Altcha challenge has no solution');
}
