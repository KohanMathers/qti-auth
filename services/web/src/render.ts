import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { escapeHtml } from '@qtiauth/email';

import { DEFAULT_ASSETS_DIR } from './assets.ts';
import { type LoadContext, loadPageData, type PageData } from './data.ts';
import type { Translator } from './i18n.ts';

export const DEFAULT_PAGES_DIR = join(DEFAULT_ASSETS_DIR, 'pages');

const cache = new Map<string, string>();

export interface RenderInput {
  name: string;
  ctx: LoadContext;
  t: Translator;
  pagesDir?: string;
  data?: PageData;
}

export class RenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RenderError';
  }
}

async function readTemplate(name: string, dir: string): Promise<string> {
  const key = `${dir}:${name}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const body = await readFile(join(dir, `${name}.html`), 'utf8');
  cache.set(key, body);
  return body;
}

const ATTR_PATTERN = /\s([a-z0-9:_-]+)(?:="([^"]*)"|='([^']*)'|=([^\s"'>/=`]+))?/giu;

function parseAttributes(open: string): Record<string, string> {
  const out: Record<string, string> = {};
  const inside = open.replace(/^<[a-zA-Z][\w-]*/, '').replace(/\/?>$/, '');
  for (const match of inside.matchAll(ATTR_PATTERN)) {
    const name = (match[1] ?? '').toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    out[name] = value;
  }
  return out;
}

function tagName(open: string): string {
  const match = /^<([a-zA-Z][\w-]*)/.exec(open);
  return (match?.[1] ?? '').toLowerCase();
}

const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
]);

interface SliceResult {
  before: string;
  openTag: string;
  inner: string;
  closeTag: string;
  after: string;
}

function sliceElement(html: string, openStart: number, open: string): SliceResult {
  const name = tagName(open);
  const openEnd = openStart + open.length;
  if (open.endsWith('/>') || VOID_ELEMENTS.has(name)) {
    return {
      before: html.slice(0, openStart),
      openTag: open,
      inner: '',
      closeTag: '',
      after: html.slice(openEnd),
    };
  }
  const openRe = new RegExp(`<${name}(?:\\s[^>]*)?>`, 'giu');
  const closeRe = new RegExp(`</${name}\\s*>`, 'giu');
  let depth = 1;
  let cursor = openEnd;
  while (depth > 0) {
    openRe.lastIndex = cursor;
    closeRe.lastIndex = cursor;
    const nextOpen = openRe.exec(html);
    const nextClose = closeRe.exec(html);
    if (nextClose === null) throw new RenderError(`Unclosed <${name}> in template`);
    if (nextOpen !== null && nextOpen.index < nextClose.index) {
      depth += 1;
      cursor = nextOpen.index + nextOpen[0].length;
    } else {
      depth -= 1;
      cursor = nextClose.index + nextClose[0].length;
      if (depth === 0) {
        return {
          before: html.slice(0, openStart),
          openTag: open,
          inner: html.slice(openEnd, nextClose.index),
          closeTag: nextClose[0],
          after: html.slice(cursor),
        };
      }
    }
  }
  throw new RenderError(`Could not slice <${name}>`);
}

function findOpenTagWithAttr(html: string, attr: string): { index: number; open: string } | null {
  const pattern = new RegExp(`<[a-zA-Z][\\w-]*(?=[^>]*\\s${attr}(?:=|\\s|/?>))[^>]*>`, 'u');
  const match = pattern.exec(html);
  if (match === null) return null;
  return { index: match.index, open: match[0] };
}

function interpolate(source: string, values: PageData): string {
  return source.replace(/\{([a-z0-9_]+)\}/giu, (match, key: string) => {
    const value = values[key];
    return value === undefined || value === null ? match : escapeHtml(String(value));
  });
}

function removeElement(html: string, needle: { index: number; open: string }): string {
  const slice = sliceElement(html, needle.index, needle.open);
  return `${slice.before}${slice.after}`;
}

function stripAttr(open: string, attr: string): string {
  const pattern = new RegExp(`\\s${attr}(?:="[^"]*"|='[^']*'|=[^\\s"'>/=\`]+)?`, 'u');
  return open.replace(pattern, '');
}

function processDataShow(html: string, data: PageData): string {
  let out = html;
  while (true) {
    const found = findOpenTagWithAttr(out, 'data-show');
    if (found === null) break;
    const attrs = parseAttributes(found.open);
    const expr = attrs['data-show'] ?? '';
    const negated = expr.startsWith('!');
    const key = negated ? expr.slice(1) : expr;
    const raw = data[key];
    const truthy = Boolean(raw) && raw !== 0 && raw !== '';
    const keep = negated ? !truthy : truthy;
    if (keep) {
      const replaced = stripAttr(found.open, 'data-show');
      out = `${out.slice(0, found.index)}${replaced}${out.slice(found.index + found.open.length)}`;
    } else {
      out = removeElement(out, found);
    }
  }
  return out;
}

function processDataBindText(html: string, data: PageData): string {
  let out = html;
  const seen = new Set<number>();
  while (true) {
    const found = findOpenTagWithAttr(out, 'data-bind-text');
    if (found === null) break;
    if (seen.has(found.index)) break;
    seen.add(found.index);
    const attrs = parseAttributes(found.open);
    const key = attrs['data-bind-text'] ?? '';
    const value = data[key];
    const slice = sliceElement(out, found.index, found.open);
    const text = value === undefined || value === null ? slice.inner : escapeHtml(String(value));
    const replacedOpen = found.open.replace(
      /\sdata-bind-text(?:="[^"]*"|='[^']*')?/u,
      ` data-bind-text-done="${escapeHtml(key)}"`,
    );
    out = `${slice.before}${replacedOpen}${text}${slice.closeTag}${slice.after}`;
  }
  return out.replaceAll('data-bind-text-done="', 'data-bind-text="');
}

function processDataField(html: string, data: PageData): string {
  let out = html;
  while (true) {
    const found = findOpenTagWithAttr(out, 'data-field');
    if (found === null) break;
    const attrs = parseAttributes(found.open);
    const key = attrs['data-field'] ?? '';
    const slice = sliceElement(out, found.index, found.open);
    const value = data[key];
    const text = value === undefined || value === null ? slice.inner : escapeHtml(String(value));
    const replacedOpen = found.open.replace(
      /\sdata-field(?:="[^"]*"|='[^']*')?/u,
      ` data-field-done="${escapeHtml(key)}"`,
    );
    out = `${slice.before}${replacedOpen}${text}${slice.closeTag}${slice.after}`;
  }
  return out.replaceAll('data-field-done="', 'data-field="');
}

function processDataBindAttr(html: string, data: PageData): string {
  const attrPattern = /\sdata-bind-([a-z]+)="([^"]*)"/giu;
  return html.replace(/<[a-zA-Z][\w-]*[^>]*>/g, (openTag) => {
    let next = openTag;
    for (const match of openTag.matchAll(attrPattern)) {
      const [whole, attr, key] = match;
      if (attr === 'text') continue;
      const value = data[key ?? ''];
      if (value === undefined) continue;
      let injected = '';
      if (attr === 'hidden') {
        if (value) injected = ' hidden';
      } else if (value === true) {
        injected = ` ${attr}=""`;
      } else if (value === false || value === null) {
        injected = '';
      } else {
        injected = ` ${attr}="${escapeHtml(String(value))}"`;
      }
      next = next.replace(whole ?? '', `${whole}${injected}`);
    }
    return next;
  });
}

function processDataItem(html: string, data: PageData): string {
  let out = html;
  let cursor = 0;
  while (true) {
    const re = /<template\s[^>]*data-item="([^"]+)"[^>]*>([\s\S]*?)<\/template>/u;
    const slice = out.slice(cursor);
    const templateMatch = re.exec(slice);
    if (templateMatch === null) break;
    const absoluteIndex = cursor + templateMatch.index;
    const [whole, name, inner] = templateMatch;
    if (whole === undefined || name === undefined) break;
    const items = data[name];
    const rows: string[] = [];
    if (Array.isArray(items)) {
      for (const item of items) {
        const asRow = item === null || typeof item !== 'object' ? { value: item } : (item as PageData);
        let row = (inner ?? '').trim();
        row = interpolate(row, asRow);
        row = processDataShow(row, asRow);
        row = processDataBindAttr(row, asRow);
        row = processDataBindText(row, asRow);
        row = processDataField(row, asRow);
        rows.push(row);
      }
    }
    out = `${out.slice(0, absoluteIndex)}${whole}${rows.join('')}${out.slice(absoluteIndex + whole.length)}`;
    cursor = absoluteIndex + whole.length + rows.join('').length;
  }
  return out;
}

function processDataSlot(html: string, data: PageData): string {
  let out = html;
  const processed = new Set<number>();
  while (true) {
    const found = findOpenTagWithAttr(out, 'data-slot');
    if (found === null) break;
    if (processed.has(found.index)) break;
    processed.add(found.index);
    const attrs = parseAttributes(found.open);
    const name = attrs['data-slot'] ?? '';
    const stateKey = `${name}_state`;
    const state = typeof data[stateKey] === 'string' ? String(data[stateKey]) : undefined;
    const replacedOpen = found.open.replace(
      /\sdata-slot(?:="[^"]*"|='[^']*')?/u,
      ` data-slot-done="${escapeHtml(name)}"`,
    );
    if (state === undefined) {
      out = `${out.slice(0, found.index)}${replacedOpen}${out.slice(found.index + found.open.length)}`;
      continue;
    }
    const slice = sliceElement(out, found.index, found.open);
    const innerProcessed = applyStates(slice.inner, state);
    out = `${slice.before}${replacedOpen}${innerProcessed}${slice.closeTag}${slice.after}`;
  }
  return out.replaceAll('data-slot-done="', 'data-slot="');
}

function applyStates(inner: string, activeState: string): string {
  let out = inner;
  while (true) {
    const found = findOpenTagWithAttr(out, 'data-state');
    if (found === null) break;
    const attrs = parseAttributes(found.open);
    const state = attrs['data-state'] ?? '';
    const slice = sliceElement(out, found.index, found.open);
    if (state === activeState) {
      const replacedOpen = found.open.replace(
        /\sdata-state(?:="[^"]*"|='[^']*')?/u,
        ` data-state-done="${escapeHtml(state)}"`,
      );
      out = `${slice.before}${replacedOpen}${slice.inner}${slice.closeTag}${slice.after}`;
    } else {
      const stripped = found.open.replace(/\sdata-state(?:="[^"]*"|='[^']*')?/u, '');
      const hiddenOpen = stripped.replace(/>$/, ` hidden data-state-done="${escapeHtml(state)}">`);
      out = `${slice.before}${hiddenOpen}${slice.inner}${slice.closeTag}${slice.after}`;
    }
  }
  return out.replaceAll('data-state-done="', 'data-state="');
}

function processDataT(html: string, t: Translator): string {
  let out = html;
  while (true) {
    const found = findOpenTagWithAttr(out, 'data-t');
    if (found === null) break;
    const attrs = parseAttributes(found.open);
    const key = attrs['data-t'] ?? '';
    const slice = sliceElement(out, found.index, found.open);
    const fallback = slice.inner.trim().replace(/\s+/gu, ' ');
    const translated = t(key, fallback);
    const replacedOpen = found.open.replace(
      /\sdata-t(?:="[^"]*"|='[^']*')?/u,
      ` data-t-done="${escapeHtml(key)}"`,
    );
    out = `${slice.before}${replacedOpen}${escapeHtml(translated)}${slice.closeTag}${slice.after}`;
  }
  return out.replaceAll('data-t-done="', 'data-t="');
}

export async function renderPage(input: RenderInput): Promise<string> {
  const template = await readTemplate(input.name, input.pagesDir ?? DEFAULT_PAGES_DIR);
  const data = input.data ?? (await loadPageData(input.name, input.ctx));
  let out = template;
  out = processDataItem(out, data);
  out = processDataSlot(out, data);
  out = processDataShow(out, data);
  out = processDataBindAttr(out, data);
  out = processDataBindText(out, data);
  out = processDataField(out, data);
  out = processDataT(out, input.t);
  return out;
}

export function clearRenderCache(): void {
  cache.clear();
}
