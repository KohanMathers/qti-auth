import { randomBytes } from 'node:crypto';

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export interface HtmlPage {
  title: string;
  product: string;
  body: string;
  status?: number;
  headers?: Record<string, string>;
  refreshSeconds?: number;
  scripts?: HtmlScripts;
}

export interface HtmlScripts {
  nonce: string;
  sources?: readonly string[];
}

export function newNonce(): string {
  return randomBytes(16).toString('base64');
}

export function contentSecurityPolicy(scripts: HtmlScripts | undefined): string {
  const scriptSrc =
    scripts === undefined
      ? "'none'"
      : [`'nonce-${scripts.nonce}'`, ...(scripts.sources ?? [])].join(' ');
  return [
    "default-src 'none'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export function htmlResponse(page: HtmlPage): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex">
${page.refreshSeconds === undefined ? '' : `<meta http-equiv="refresh" content="${String(page.refreshSeconds)}">`}
<title>${escapeHtml(page.title)} · ${escapeHtml(page.product)}</title>
</head>
<body>
<main>
<h1>${escapeHtml(page.title)}</h1>
${page.body}
</main>
</body>
</html>
`;
  return new Response(html, {
    status: page.status ?? 200,
    headers: {
      ...page.headers,
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': contentSecurityPolicy(page.scripts),
    },
  });
}

export function hiddenInput(name: string, value: string): string {
  return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
}
