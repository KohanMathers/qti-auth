import type { GeoIp } from '@qtiauth/geoip';

const attached = new WeakMap<object, GeoIp>();

export function attachGeoIp(ctx: object, geoip: GeoIp): void {
  attached.set(ctx, geoip);
}

export function geoIpOf(ctx: object): GeoIp | undefined {
  return attached.get(ctx);
}
