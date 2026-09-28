import { randomBytes } from 'node:crypto';

import type { QtiauthConfig } from '@qtiauth/config';
import { escapeHtml } from '@qtiauth/email';

export interface ShellInput {
  product_name: string;
  locale: string;
  base_path: string;
  meta_origin: string | undefined;
  nonce: string;
}

export function newNonce(): string {
  return randomBytes(16).toString('base64');
}

export function contentSecurityPolicy(nonce: string, metaOrigin: string | undefined): string {
  const connect = metaOrigin === undefined ? "'self'" : `'self' ${metaOrigin}`;
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src ${connect}`,
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export function shellHtml(input: ShellInput): string {
  const base = input.base_path === '/' ? '' : input.base_path;
  const bootstrap = {
    base_path: input.base_path,
    locale: input.locale,
    meta_origin: input.meta_origin ?? null,
  };
  return `<!doctype html>
<html lang="${escapeHtml(input.locale)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(input.product_name)}</title>
<link rel="stylesheet" href="${base}/theme.css">
<link rel="stylesheet" href="${base}/styles.css">
</head>
<body>
<a class="qtiauth-skip-link" href="#qtiauth-main">Skip to main content</a>
<div id="qtiauth-app" aria-busy="true">
<main id="qtiauth-main" tabindex="-1">
<p>Loading ${escapeHtml(input.product_name)}…</p>
</main>
</div>
<div id="qtiauth-live" role="status" aria-live="polite" aria-atomic="true"></div>
<script type="application/json" id="qtiauth-bootstrap">${escapeHtml(JSON.stringify(bootstrap))}</script>
<script type="module" nonce="${escapeHtml(input.nonce)}" src="${base}/app.js"></script>
</body>
</html>
`;
}

export type ShellConfig = Pick<QtiauthConfig, 'branding' | 'surfaces'>;

export function shellResponse(
  config: ShellConfig,
  options: { basePath: string; metaOrigin: string | undefined },
): Response {
  const nonce = newNonce();
  const html = shellHtml({
    product_name: config.branding.product_name,
    locale: 'en-GB',
    base_path: options.basePath,
    meta_origin: options.metaOrigin,
    nonce,
  });
  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': contentSecurityPolicy(nonce, options.metaOrigin),
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
    },
  });
}
