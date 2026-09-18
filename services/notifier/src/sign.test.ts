import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  generateWebhookSecret,
  signWebhook,
  verifyWebhookSignature,
  webhookMessageId,
  webhookSecretHint,
  webhookSignatureHeader,
} from './sign.ts';

describe('standard webhooks signing', () => {
  it('produces v1 signatures a receiver can verify from the spec formula', () => {
    const secret = generateWebhookSecret();
    const id = webhookMessageId('0199a0e0-0000-7000-8000-00000000beef');
    const timestamp = 1_718_191_200;
    const body = '{"type":"identity.user.banned"}';
    const header = signWebhook(secret, id, timestamp, body);

    const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
    const expected = createHmac('sha256', key)
      .update(`${id}.${String(timestamp)}.${body}`)
      .digest('base64');
    expect(header).toBe(`v1,${expected}`);
    expect(verifyWebhookSignature(secret, id, timestamp, body, header)).toBe(true);
    expect(verifyWebhookSignature(secret, id, timestamp, body, `${header}x`)).toBe(false);
  });

  it('signs with current and previous secrets during rotation', () => {
    const current = generateWebhookSecret();
    const previous = generateWebhookSecret();
    const header = webhookSignatureHeader([current, previous], 'msg_1', 1, '{}');
    expect(header.split(' ')).toHaveLength(2);
    expect(verifyWebhookSignature(current, 'msg_1', 1, '{}', header)).toBe(true);
    expect(verifyWebhookSignature(previous, 'msg_1', 1, '{}', header.split(' ')[1] ?? '')).toBe(
      true,
    );
    expect(webhookSecretHint(current)).toHaveLength(4);
    expect(generateWebhookSecret().startsWith('whsec_')).toBe(true);
  });
});
