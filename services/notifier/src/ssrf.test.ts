import { describe, expect, it } from 'vitest';

import {
  assertPublicWebhookUrl,
  isBlockedAddress,
  type DnsLookup,
  WebhookTargetError,
} from './ssrf.ts';

describe('webhook SSRF checks', () => {
  it('blocks loopback, private and link-local addresses', () => {
    expect(isBlockedAddress('127.0.0.1')).toBe(true);
    expect(isBlockedAddress('10.0.0.4')).toBe(true);
    expect(isBlockedAddress('192.168.1.9')).toBe(true);
    expect(isBlockedAddress('172.16.5.4')).toBe(true);
    expect(isBlockedAddress('169.254.169.254')).toBe(true);
    expect(isBlockedAddress('::1')).toBe(true);
    expect(isBlockedAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isBlockedAddress('8.8.8.8')).toBe(false);
  });

  it('refuses a URL whose DNS resolves to loopback unless private targets are allowed', async () => {
    const lookup: DnsLookup = () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]);
    await expect(
      assertPublicWebhookUrl('https://hooks.example.com/path', { allowPrivate: false, lookup }),
    ).rejects.toThrow(WebhookTargetError);
    await expect(
      assertPublicWebhookUrl('https://hooks.example.com/path', { allowPrivate: true, lookup }),
    ).resolves.toBeInstanceOf(URL);
  });

  it('refuses credentials, non-http schemes and a literal loopback IP', async () => {
    await expect(
      assertPublicWebhookUrl('https://user:pass@example.com/hook', { allowPrivate: false }),
    ).rejects.toThrow(/userinfo/);
    await expect(
      assertPublicWebhookUrl('ftp://example.com/hook', { allowPrivate: false }),
    ).rejects.toThrow(/http or https/);
    await expect(
      assertPublicWebhookUrl('http://127.0.0.1/hook', { allowPrivate: false }),
    ).rejects.toThrow(/127\.0\.0\.1/);
  });
});
