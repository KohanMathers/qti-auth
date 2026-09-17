import type { QtiauthConfig } from '@qtiauth/config';

export type HstsConfig = QtiauthConfig['gateway']['hsts'];

const PERMISSIONS_POLICY = [
  'accelerometer=()',
  'camera=()',
  'geolocation=()',
  'gyroscope=()',
  'magnetometer=()',
  'microphone=()',
  'payment=()',
  'usb=()',
].join(', ');

const REMOVED_HEADERS = ['server', 'x-powered-by'];

export function hstsValue(config: HstsConfig): string {
  return [
    `max-age=${String(Math.floor(config.max_age / 1000))}`,
    ...(config.include_subdomains ? ['includeSubDomains'] : []),
    ...(config.preload ? ['preload'] : []),
  ].join('; ');
}

export function applySecurityHeaders(headers: Headers, hsts: string): void {
  for (const name of REMOVED_HEADERS) headers.delete(name);
  headers.set('Strict-Transport-Security', hsts);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Permissions-Policy', PERMISSIONS_POLICY);
  headers.set('X-Frame-Options', 'DENY');

  const csp = headers.get('content-security-policy');
  if (csp === null) {
    headers.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  } else if (!/(?:^|;)\s*frame-ancestors\s+'none'\s*(?:;|$)/i.test(csp)) {
    const directives = csp
      .split(';')
      .map((directive) => directive.trim())
      .filter((directive) => directive !== '' && !/^frame-ancestors\b/i.test(directive));
    headers.set('Content-Security-Policy', [...directives, "frame-ancestors 'none'"].join('; '));
  }
}
