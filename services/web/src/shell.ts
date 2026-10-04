import { randomBytes } from 'node:crypto';

import type { QtiauthConfig } from '@qtiauth/config';
import { escapeHtml } from '@qtiauth/email';

export interface ShellInput {
  product_name: string;
  locale: string;
  base_path: string;
  meta_origin: string | undefined;
  nonce: string;
  content: string;
  theme: 'light' | 'dark' | 'system' | undefined;
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

function themeAttribute(theme: ShellInput['theme']): string {
  if (theme === 'light') return ' data-theme="light"';
  if (theme === 'dark') return ' data-theme="dark"';
  return '';
}

export function shellHtml(input: ShellInput): string {
  const base = input.base_path === '/' ? '' : input.base_path;
  return `<!doctype html>
<html lang="${escapeHtml(input.locale)}"${themeAttribute(input.theme)}>
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
<div id="qtiauth-app">
<main id="qtiauth-main" tabindex="-1">
${input.content}
</main>
</div>
<div id="qtiauth-live" role="status" aria-live="polite" aria-atomic="true"></div>
<script type="module" nonce="${escapeHtml(input.nonce)}" src="${base}/app.js"></script>
</body>
</html>
`;
}

export type ShellConfig = Pick<QtiauthConfig, 'branding' | 'surfaces'>;

export interface ShellOptions {
  basePath: string;
  metaOrigin: string | undefined;
  content: string;
  locale: string;
  theme: ShellInput['theme'];
}

export function shellResponse(config: ShellConfig, options: ShellOptions): Response {
  const nonce = newNonce();
  const html = shellHtml({
    product_name: config.branding.product_name,
    locale: options.locale,
    base_path: options.basePath,
    meta_origin: options.metaOrigin,
    nonce,
    content: options.content,
    theme: options.theme,
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
