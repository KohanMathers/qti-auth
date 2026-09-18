import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const PREFIX = 'whsec_';
const SCHEME = 'v1';

export function generateWebhookSecret(): string {
  return `${PREFIX}${randomBytes(32).toString('base64')}`;
}

export function webhookSecretHint(secret: string): string {
  return secret.slice(-4);
}

function signingKey(secret: string): Buffer {
  const raw = secret.startsWith(PREFIX) ? secret.slice(PREFIX.length) : secret;
  return Buffer.from(raw, 'base64');
}

export function webhookMessageId(deliveryId: string): string {
  return `msg_${deliveryId.replaceAll('-', '')}`;
}

export function signWebhook(secret: string, id: string, timestamp: number, body: string): string {
  const signature = createHmac('sha256', signingKey(secret))
    .update(`${id}.${String(timestamp)}.${body}`)
    .digest('base64');
  return `${SCHEME},${signature}`;
}

export function webhookSignatureHeader(
  secrets: readonly string[],
  id: string,
  timestamp: number,
  body: string,
): string {
  return secrets.map((secret) => signWebhook(secret, id, timestamp, body)).join(' ');
}

export function verifyWebhookSignature(
  secret: string,
  id: string,
  timestamp: number,
  body: string,
  header: string,
): boolean {
  const expected = signWebhook(secret, id, timestamp, body);
  const found = header.split(' ').find((part) => part.startsWith(`${SCHEME},`));
  if (found?.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(found), Buffer.from(expected));
}
