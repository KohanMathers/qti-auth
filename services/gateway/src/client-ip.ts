import { BlockList, isIP } from 'node:net';

export interface TrustedProxies {
  trusts: (address: string) => boolean;
}

export function normalizeIp(value: string): string | null {
  let address = value.trim();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(address);
  if (bracketed?.[1]) address = bracketed[1];
  else if (/^[\d.]+:\d+$/.test(address)) address = address.slice(0, address.lastIndexOf(':'));
  const zone = address.indexOf('%');
  if (zone !== -1) address = address.slice(0, zone);
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped?.[1]) address = mapped[1];
  const version = isIP(address);
  if (version === 0) return null;
  return version === 6 ? address.toLowerCase() : address;
}

export function trustedProxies(entries: readonly string[]): TrustedProxies {
  const list = new BlockList();
  for (const entry of entries) {
    const [address = '', prefix] = entry.split('/');
    const type = isIP(address) === 6 ? 'ipv6' : 'ipv4';
    if (prefix === undefined) list.addAddress(address, type);
    else list.addSubnet(address, Number(prefix), type);
  }
  return {
    trusts: (address) => {
      const normalized = normalizeIp(address);
      if (normalized === null) return false;
      return list.check(normalized, isIP(normalized) === 6 ? 'ipv6' : 'ipv4');
    },
  };
}

export function clientIp(
  peer: string | undefined,
  forwardedFor: string | null,
  proxies: TrustedProxies,
): string {
  const socket = normalizeIp(peer ?? '') ?? 'unknown';
  if (forwardedFor === null || !proxies.trusts(socket)) return socket;

  let nearest = socket;
  const hops = forwardedFor.split(',').reverse();
  for (const hop of hops) {
    const address = normalizeIp(hop);
    if (address === null) return nearest;
    if (!proxies.trusts(address)) return address;
    nearest = address;
  }
  return nearest;
}
