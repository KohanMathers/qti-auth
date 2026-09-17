import { isIP } from 'node:net';

export function parseIp(ip: string): bigint | null {
  const version = isIP(ip);
  if (version === 4) {
    return ip.split('.').reduce((value, part) => (value << 8n) + BigInt(Number(part)), 0n);
  }
  if (version === 6) {
    return ipv6ToBigInt(ip);
  }
  return null;
}

function ipv6ToBigInt(ip: string): bigint | null {
  const [head, tail] = ip.split('::');
  const left = (head ?? '').split(':').filter((part) => part !== '');
  const right = tail === undefined ? [] : tail.split(':').filter((part) => part !== '');
  if (left.some((part) => part.includes('.'))) {
    const dotted = left.pop() ?? '';
    const mapped = ipv4Mapped(dotted);
    if (mapped === null) return null;
    left.push(...mapped);
  }
  if (right.some((part) => part.includes('.'))) {
    const dotted = right.pop() ?? '';
    const mapped = ipv4Mapped(dotted);
    if (mapped === null) return null;
    right.push(...mapped);
  }
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (tail === undefined && missing !== 0)) return null;
  const groups = [...left, ...Array.from({ length: missing }, () => '0'), ...right];
  if (groups.length !== 8) return null;
  try {
    return groups.reduce((value, part) => (value << 16n) + BigInt(`0x${part}`), 0n);
  } catch {
    return null;
  }
}

function ipv4Mapped(dotted: string): string[] | null {
  const value = parseIp(dotted);
  if (value === null) return null;
  return [((value >> 16n) & 0xffffn).toString(16), (value & 0xffffn).toString(16)];
}

export function ipSubnet(ip: string): string | null {
  const version = isIP(ip);
  if (version === 4) {
    const parts = ip.split('.');
    const [a, b, c] = parts;
    if (parts.length !== 4 || a === undefined || b === undefined || c === undefined) return null;
    return `${a}.${b}.${c}.0/24`;
  }
  if (version === 6) {
    const value = parseIp(ip);
    if (value === null) return null;
    const prefix = value >> 80n;
    const groups = Array.from({ length: 3 }, (_, index) =>
      ((prefix >> BigInt((2 - index) * 16)) & 0xffffn).toString(16),
    );
    return `${groups.join(':')}::/48`;
  }
  return null;
}

export const COUNTRY_CODE = /^[A-Z]{2}$/;

export function normalizeCountry(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const country = value.trim().toUpperCase();
  if (country === '' || country === 'ZZ' || country === 'XX' || country === 'T1') return null;
  return COUNTRY_CODE.test(country) ? country : null;
}
