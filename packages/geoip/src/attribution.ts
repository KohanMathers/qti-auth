export const DBIP_ATTRIBUTION = {
  name: 'DB-IP',
  product: 'IP to Country Lite',
  url: 'https://db-ip.com',
  license: 'CC-BY 4.0',
  license_url: 'https://creativecommons.org/licenses/by/4.0/',
  notice: 'IP Geolocation by DB-IP',
} as const;

export const MAXMIND_ATTRIBUTION = {
  name: 'MaxMind',
  product: 'GeoLite2',
  url: 'https://www.maxmind.com',
  license: 'GeoLite2 End User License Agreement',
  license_url: 'https://www.maxmind.com/en/geolite2/eula',
  notice: 'This product includes GeoLite2 data created by MaxMind',
} as const;

export type GeoipAttribution = typeof DBIP_ATTRIBUTION | typeof MAXMIND_ATTRIBUTION;
