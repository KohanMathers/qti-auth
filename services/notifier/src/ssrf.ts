import type { LookupAddress } from 'node:dns';
import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

export class WebhookTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookTargetError';
  }
}

export type DnsLookup = (
  hostname: string,
  options: { all: true },
) => Promise<readonly LookupAddress[]>;

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

export function isBlockedAddress(address: string): boolean {
  const mapped = mappedIpv4(address);
  if (mapped !== undefined) return isBlockedAddress(mapped);
  const version = isIP(address);
  if (version === 4) return blocked.check(address, 'ipv4');
  if (version === 6) return blocked.check(address, 'ipv6');
  return true;
}

export function parseWebhookUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WebhookTargetError('Must be an http or https URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new WebhookTargetError('Must be an http or https URL');
  }
  if (url.hostname === '' || url.username !== '' || url.password !== '') {
    throw new WebhookTargetError('Must be an http or https URL without userinfo');
  }
  return url;
}

const defaultLookup: DnsLookup = (host, options) => dnsLookup(host, options);

export async function resolveWebhookHost(
  hostname: string,
  lookup?: DnsLookup,
): Promise<LookupAddress[]> {
  if (isIP(hostname) !== 0) return [{ address: hostname, family: isIP(hostname) }];
  try {
    const addresses = await (lookup ?? defaultLookup)(hostname, { all: true });
    if (addresses.length === 0) throw new WebhookTargetError(`Could not resolve ${hostname}`);
    return [...addresses];
  } catch (error) {
    if (error instanceof WebhookTargetError) throw error;
    throw new WebhookTargetError(
      `Could not resolve ${hostname}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function assertPublicWebhookUrl(
  value: string,
  options: { allowPrivate: boolean; lookup?: DnsLookup | undefined } = { allowPrivate: false },
): Promise<URL> {
  const url = parseWebhookUrl(value);
  if (options.allowPrivate) return url;
  const addresses = await resolveWebhookHost(url.hostname, options.lookup);
  const blockedAddress = addresses.find((entry) => isBlockedAddress(entry.address));
  if (blockedAddress !== undefined) {
    throw new WebhookTargetError(
      `Refusing to send to ${url.hostname}: ${blockedAddress.address} is a private, loopback or link-local address`,
    );
  }
  return url;
}
