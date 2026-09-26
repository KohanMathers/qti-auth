import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';

const IMAGE_SRC =
  /^\/api\/v1\/support\/kb\/images\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const BLOCK_TAGS: Record<string, string> = {
  paragraph_open: 'p',
  bullet_list_open: 'ul',
  ordered_list_open: 'ol',
  list_item_open: 'li',
  blockquote_open: 'blockquote',
};

const INLINE_TAGS: Record<string, string> = {
  strong_open: 'strong',
  em_open: 'em',
};

const markdown = new MarkdownIt({
  html: false,
  xhtmlOut: false,
  breaks: false,
  linkify: false,
  typographer: false,
});

markdown.validateLink = (url) => safeUrl(url) !== undefined;

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function cleaned(raw: string): string | undefined {
  let value = '';
  for (const char of raw) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) continue;
    value += char;
  }
  value = value.trim();
  if (value === '' || value.startsWith('//') || value.includes('\\')) return undefined;
  return value;
}

function safeUrl(raw: string): string | undefined {
  const value = cleaned(raw);
  if (value === undefined) return undefined;
  if (IMAGE_SRC.test(value)) return escapeHtml(value);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:' && url.protocol !== 'mailto:') {
    return undefined;
  }
  if (url.username !== '' || url.password !== '') return undefined;
  return escapeHtml(value);
}

function safeImage(raw: string): string | undefined {
  const value = cleaned(raw);
  if (value === undefined) return undefined;
  if (IMAGE_SRC.test(value)) return escapeHtml(value);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  if (url.username !== '' || url.password !== '') return undefined;
  return escapeHtml(value);
}

function openType(type: string): string | undefined {
  if (!type.endsWith('_close')) return undefined;
  return `${type.slice(0, -'close'.length)}open`;
}

function renderInline(tokens: readonly Token[]): string {
  let html = '';
  let link: string | undefined;
  for (const token of tokens) {
    if (token.type === 'text' || token.type === 'html_inline') {
      html += escapeHtml(token.content);
      continue;
    }
    if (token.type === 'code_inline') {
      html += `<code>${escapeHtml(token.content)}</code>`;
      continue;
    }
    if (token.type === 'softbreak') {
      html += '\n';
      continue;
    }
    if (token.type === 'hardbreak') {
      html += '<br>';
      continue;
    }
    if (token.type === 'image') {
      const src = token.attrGet('src');
      const alt = escapeHtml((token.children ?? []).map((child) => child.content).join(''));
      const safe = src === null ? undefined : safeImage(src);
      html += safe === undefined ? alt : `<img src="${safe}" alt="${alt}">`;
      continue;
    }
    if (token.type === 'link_open') {
      const href = token.attrGet('href');
      link = href === null ? undefined : safeUrl(href);
      if (link !== undefined) html += `<a href="${link}">`;
      continue;
    }
    if (token.type === 'link_close') {
      if (link !== undefined) html += '</a>';
      link = undefined;
      continue;
    }
    const tag = INLINE_TAGS[token.type];
    if (tag !== undefined) {
      html += `<${tag}>`;
      continue;
    }
    const opened = openType(token.type);
    if (opened !== undefined && INLINE_TAGS[opened] !== undefined) {
      html += `</${INLINE_TAGS[opened]}>`;
    }
  }
  return html;
}

function renderBlock(tokens: readonly Token[]): string {
  let html = '';
  for (const token of tokens) {
    if (token.hidden && (token.type === 'paragraph_open' || token.type === 'paragraph_close')) {
      continue;
    }
    if (token.type === 'inline') {
      html += renderInline(token.children ?? []);
      continue;
    }
    if (token.type === 'fence' || token.type === 'code_block') {
      html += `<pre><code>${escapeHtml(token.content)}</code></pre>`;
      continue;
    }
    if (token.type === 'html_block') {
      html += `<p>${escapeHtml(token.content)}</p>`;
      continue;
    }
    if (token.type === 'hr') {
      html += '<hr>';
      continue;
    }
    if (token.type === 'heading_open' && /^h[1-6]$/.test(token.tag)) {
      html += `<${token.tag}>`;
      continue;
    }
    if (token.type === 'heading_close' && /^h[1-6]$/.test(token.tag)) {
      html += `</${token.tag}>`;
      continue;
    }
    const tag = BLOCK_TAGS[token.type];
    if (tag !== undefined) {
      html += `<${tag}>`;
      continue;
    }
    const opened = openType(token.type);
    if (opened !== undefined && BLOCK_TAGS[opened] !== undefined) {
      html += `</${BLOCK_TAGS[opened]}>`;
    }
  }
  return html;
}

export function renderMarkdown(source: string): string {
  return renderBlock(markdown.parse(source, {}));
}
