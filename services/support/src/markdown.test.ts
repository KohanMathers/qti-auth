import { describe, expect, it } from 'vitest';

import { renderMarkdown } from './markdown.ts';

const IMAGE = '/api/v1/support/kb/images/00000000-0000-4000-8000-000000000001';

const CORPUS = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '<svg onload=alert(1)>',
  '<iframe src="javascript:alert(1)"></iframe>',
  '<math><mi xlink:href="javascript:alert(1)">x</mi></math>',
  '<object data="javascript:alert(1)"></object>',
  '<embed src="javascript:alert(1)">',
  '<link rel=stylesheet href="javascript:alert(1)">',
  '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
  '<style>body{background:url("javascript:alert(1)")}</style>',
  '<form action="javascript:alert(1)"><input type=submit></form>',
  '<details open ontoggle=alert(1)>',
  '[click](javascript:alert(1))',
  '[click](JaVaScRiPt:alert(1))',
  '[click](java\tscript:alert(1))',
  '[click](javascript:alert(1))',
  '[click](data:text/html,<script>alert(1)</script>)',
  '[click](vbscript:msgbox(1))',
  '[click](file:///etc/passwd)',
  '[click](//evil.example/a)',
  '[click](https://user:pass@example.com/)',
  '[x](javascript&#58;alert(1))',
  '[x](<javascript:alert(1)>)',
  '![x](javascript:alert(1))',
  '![x](data:text/html;base64,PHNjcmlwdD4=)',
  '![x](//evil.example/a.png)',
  `![x](${IMAGE} "onload=alert(1)")`,
  '[x](https://example.com" onclick="alert(1))',
  '```\n<script>alert(1)</script>\n```',
  '`<script>alert(1)</script>`',
];

function tags(html: string): string[] {
  return html.match(/<\/?[a-z0-9]+(?:\s[^>]*)?>/gi) ?? [];
}

function assertInert(html: string): void {
  const stripped = html.replaceAll(
    /<\/?(?:p|br|h[1-6]|ul|ol|li|blockquote|pre|code|em|strong|a|img|hr)(?:\s[^>]*)?>/gi,
    '',
  );
  expect(stripped).not.toMatch(/[<>]/);
  for (const tag of tags(html)) {
    expect(tag.toLowerCase()).not.toMatch(/\son[a-z]+\s*=/);
    expect(tag.toLowerCase()).not.toMatch(/javascript:/);
    expect(tag.toLowerCase()).not.toMatch(/data:/);
    expect(tag.toLowerCase()).not.toMatch(/vbscript:/);
    expect(tag.toLowerCase()).not.toMatch(/\sstyle\s*=/);
  }
}

describe('renderMarkdown', () => {
  it('renders the XSS corpus as inert HTML', () => {
    for (const source of CORPUS) {
      assertInert(renderMarkdown(source));
    }
  });

  it('keeps headings, lists, emphasis, code and safe links', () => {
    const html = renderMarkdown(
      '# Title\n\n**bold** and *italic*\n\n- one\n- two\n\n`code`\n\n[docs](https://example.com/a?b=1&c=2)\n',
    );
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
    expect(html).toContain('<li>one</li>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('href="https://example.com/a?b=1&amp;c=2"');
    assertInert(html);
  });

  it('allows uploaded images and escapes code fences', () => {
    const html = renderMarkdown(
      `See ![diagram](${IMAGE})\n\n\`\`\`\n<script>alert(1)</script>\n\`\`\`\n`,
    );
    expect(html).toContain(`<img src="${IMAGE}" alt="diagram">`);
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    assertInert(html);
  });
});
