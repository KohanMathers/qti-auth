import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

export class LogoutTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LogoutTargetError';
  }
}

const blocked = new BlockList();
blocked.addAddress('0.0.0.0', 'ipv4');
blocked.addSubnet('10.0.0.0', 8, 'ipv4');
blocked.addSubnet('127.0.0.0', 8, 'ipv4');
blocked.addSubnet('169.254.0.0', 16, 'ipv4');
blocked.addSubnet('172.16.0.0', 12, 'ipv4');
blocked.addSubnet('192.168.0.0', 16, 'ipv4');
blocked.addAddress('::', 'ipv6');
blocked.addAddress('::1', 'ipv6');
blocked.addSubnet('fc00::', 7, 'ipv6');
blocked.addSubnet('fe80::', 10, 'ipv6');

function mappedIpv4(address: string): string | undefined {
  const match = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  return match?.[1];
}

export function isLoopbackLogoutHost(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === '::1';
}

export function isBlockedAddress(address: string): boolean {
  const mapped = mappedIpv4(address);
  if (mapped !== undefined) return isBlockedAddress(mapped);
  const version = isIP(address);
  if (version === 4) return blocked.check(address, 'ipv4');
  if (version === 6) return blocked.check(address, 'ipv6');
  return true;
}

export interface LogoutHttpResult {
  status: number;
}

export interface LogoutPost {
  url: string;
  token: string;
  timeout: number;
  allowPrivate: boolean;
}

export type LogoutHttp = (request: LogoutPost) => Promise<LogoutHttpResult>;

export function createLogoutHttp(): LogoutHttp {
  return async (request) => {
    const url = new URL(request.url);
    if (!request.allowPrivate && !isLoopbackLogoutHost(url.hostname)) {
      const addresses =
        isIP(url.hostname) === 0
          ? await dnsLookup(url.hostname, { all: true })
          : [{ address: url.hostname, family: isIP(url.hostname) }];
      const blockedAddress = addresses.find((entry) => isBlockedAddress(entry.address));
      if (blockedAddress !== undefined) {
        throw new LogoutTargetError(
          `Refusing to send to ${url.hostname}: ${blockedAddress.address} is a private, loopback or link-local address`,
        );
      }
    }
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ logout_token: request.token }).toString(),
      signal: AbortSignal.timeout(request.timeout),
      redirect: 'manual',
    });
    await response.arrayBuffer();
    return { status: response.status };
  };
}
