import { describe, expect, it } from 'vitest';

import { clientIp, normalizeIp, trustedProxies } from './client-ip.ts';

const proxies = trustedProxies(['10.0.0.0/8', '192.168.1.1', 'fd00::/8']);

describe('normalizeIp', () => {
  it('unwraps ports, brackets, zones and IPv4-mapped addresses', () => {
    expect(normalizeIp('203.0.113.9')).toBe('203.0.113.9');
    expect(normalizeIp(' 203.0.113.9:4431 ')).toBe('203.0.113.9');
    expect(normalizeIp('[2001:DB8::1]:443')).toBe('2001:db8::1');
    expect(normalizeIp('::ffff:10.1.2.3')).toBe('10.1.2.3');
    expect(normalizeIp('fe80::1%eth0')).toBe('fe80::1');
    expect(normalizeIp('unknown')).toBeNull();
  });
});

describe('clientIp', () => {
  it('uses the socket address when there are no trusted proxies', () => {
    const none = trustedProxies([]);
    expect(clientIp('203.0.113.9', '198.51.100.1', none)).toBe('203.0.113.9');
  });

  it('ignores X-Forwarded-For from an untrusted peer', () => {
    expect(clientIp('203.0.113.9', '198.51.100.1', proxies)).toBe('203.0.113.9');
  });

  it('takes the rightmost untrusted hop', () => {
    expect(clientIp('10.0.0.2', '6.6.6.6, 198.51.100.1, 10.0.0.9', proxies)).toBe('198.51.100.1');
    expect(clientIp('::ffff:10.0.0.2', '198.51.100.1', proxies)).toBe('198.51.100.1');
    expect(clientIp('fd00::1', '2001:db8::5', proxies)).toBe('2001:db8::5');
  });

  it('falls back to the nearest trusted hop', () => {
    expect(clientIp('10.0.0.2', '192.168.1.1, 10.0.0.3', proxies)).toBe('192.168.1.1');
    expect(clientIp('10.0.0.2', 'garbage, 10.0.0.3', proxies)).toBe('10.0.0.3');
    expect(clientIp('10.0.0.2', '', proxies)).toBe('10.0.0.2');
  });
});
