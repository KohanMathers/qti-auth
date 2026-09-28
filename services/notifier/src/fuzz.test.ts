import { randomBytes, randomInt } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  assertPublicWebhookUrl,
  type DnsLookup,
  isBlockedAddress,
  parseWebhookUrl,
  WebhookTargetError,
} from './ssrf.ts';

const ITERATIONS = 2000;

const SCHEMES = [
  'http',
  'https',
  'javascript',
  'file',
  'ftp',
  'data',
  'gopher',
  'ws',
  'wss',
  '',
  'HTTPS',
];
const HOSTS = [
  'hooks.example.com',
  '127.0.0.1',
  '10.0.0.1',
  '169.254.169.254',
  '192.168.1.1',
  '172.16.0.1',
  '[::1]',
  '[fe80::1]',
  '[fc00::1]',
  '8.8.8.8',
  '',
  '::ffff:127.0.0.1',
];
const PATHS = ['/hook', '/', '/../etc/passwd', '/%00', '/deep/path'];
const CREDENTIALS = ['', 'user:pass@', 'user@'];

function pick<T>(source: readonly T[]): T {
  const value = source[randomInt(0, source.length)];
  if (value === undefined) throw new Error('pick from empty source');
  return value;
}

function randomUrl(): string {
  const scheme = pick(SCHEMES);
  const host = pick(HOSTS);
  const path = pick(PATHS);
  const credentials = pick(CREDENTIALS);
  const kind = randomInt(0, 5);
  if (kind === 0) return `${scheme}://${credentials}${host}${path}`;
  if (kind === 1) return `${scheme}://${credentials}${host}:${String(randomInt(1, 70000))}${path}`;
  if (kind === 2) return randomBytes(randomInt(0, 128)).toString('utf8');
  if (kind === 3)
    return `${scheme}://${credentials}${host}${path}?x=${randomBytes(3).toString('hex')}`;
  return `${scheme}://${host}${path}#frag`;
}

function constantLookup(address: string, family: 4 | 6 = 4): DnsLookup {
  return () => Promise.resolve([{ address, family }]);
}

describe('webhook URL fuzz', () => {
  it('never throws outside of the WebhookTargetError contract', () => {
    for (let i = 0; i < ITERATIONS; i++) {
      const raw = randomUrl();
      try {
        parseWebhookUrl(raw);
      } catch (error) {
        expect(error).toBeInstanceOf(WebhookTargetError);
      }
    }
  });

  it('only ever accepts http and https targets with no userinfo', () => {
    for (let i = 0; i < ITERATIONS; i++) {
      const raw = randomUrl();
      try {
        const url = parseWebhookUrl(raw);
        expect(['http:', 'https:']).toContain(url.protocol);
        expect(url.username).toBe('');
        expect(url.password).toBe('');
        expect(url.hostname).not.toBe('');
      } catch (error) {
        expect(error).toBeInstanceOf(WebhookTargetError);
      }
    }
  });

  it('refuses any URL that resolves to a bogon address unless private targets are allowed', async () => {
    const cases: { address: string; family: 4 | 6 }[] = [
      { address: '127.0.0.1', family: 4 },
      { address: '10.0.0.1', family: 4 },
      { address: '172.16.0.1', family: 4 },
      { address: '192.168.1.1', family: 4 },
      { address: '169.254.169.254', family: 4 },
      { address: '::1', family: 6 },
      { address: 'fe80::1', family: 6 },
      { address: 'fc00::1', family: 6 },
      { address: '::ffff:127.0.0.1', family: 6 },
    ];
    for (const { address, family } of cases) {
      const lookup = constantLookup(address, family);
      await expect(
        assertPublicWebhookUrl('https://hooks.example.com/x', { allowPrivate: false, lookup }),
        address,
      ).rejects.toThrow(WebhookTargetError);
      await expect(
        assertPublicWebhookUrl('https://hooks.example.com/x', { allowPrivate: true, lookup }),
      ).resolves.toBeInstanceOf(URL);
    }
  });

  it('lets public routable addresses through', async () => {
    const lookup = constantLookup('8.8.8.8', 4);
    await expect(
      assertPublicWebhookUrl('https://hooks.example.com/x', { allowPrivate: false, lookup }),
    ).resolves.toBeInstanceOf(URL);
  });

  it('never treats an unknown address family as public', () => {
    for (let i = 0; i < 200; i++) {
      const junk = randomBytes(randomInt(0, 32)).toString('hex');
      expect(isBlockedAddress(junk)).toBe(true);
    }
  });
});
