const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

export interface HtmlPage {
  title: string;
  product: string;
  body: string;
  status?: number;
  headers?: Record<string, string>;
}

export function htmlResponse(page: HtmlPage): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex">
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
    },
  });
}

export function hiddenInput(name: string, value: string): string {
  return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
}
