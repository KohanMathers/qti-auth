import { describe, expect, it } from 'vitest';

import { ipSubnet, normalizeCountry, parseIp } from './ip.ts';

describe('parseIp', () => {
  it('turns IPv4 and IPv6 addresses into integers', () => {
    expect(parseIp('1.2.3.4')).toBe(0x01020304n);
    expect(parseIp('::1')).toBe(1n);
    expect(parseIp('2001:db8::1')).toBe(0x20010db8000000000000000000000001n);
    expect(parseIp('not-an-ip')).toBeNull();
  });
});

describe('ipSubnet', () => {
  it('uses /24 for IPv4 and /48 for IPv6', () => {
    expect(ipSubnet('203.0.113.45')).toBe('203.0.113.0/24');
    expect(ipSubnet('2001:db8:1:2::3')).toBe('2001:db8:1::/48');
    expect(ipSubnet('nope')).toBeNull();
  });
});

describe('normalizeCountry', () => {
  it('keeps ISO country codes and drops unknowns', () => {
    expect(normalizeCountry('gb')).toBe('GB');
    expect(normalizeCountry(' ZZ ')).toBeNull();
    expect(normalizeCountry('GBR')).toBeNull();
    expect(normalizeCountry('')).toBeNull();
  });
});
