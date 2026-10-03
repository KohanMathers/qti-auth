import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const assets = new URL('./assets/', import.meta.url);
const source = await readFile(new URL('pages.js', assets), 'utf8');

async function template(name: string): Promise<string> {
  return readFile(new URL(`pages/${name}.html`, assets), 'utf8');
}

function renderers(): [id: string, render: string][] {
  const registry = source.slice(source.indexOf('export const PAGES'));
  return [...registry.matchAll(/'?([\w-]+)'?: \{\s*path: '[^']+',\s*render: (\w+)/gu)].map(
    (match) => [match[1] ?? '', match[2] ?? ''],
  );
}

function body(fn: string): string {
  const start = source.indexOf(`function ${fn}(`);
  const end = source.indexOf('\nfunction ', start + 1);
  return source.slice(start, end === -1 ? undefined : end);
}

function all(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].map((match) => match[1] ?? '');
}

function expectedSelectors(fn: string): string[] {
  const text = body(fn);
  const selectors = [
    ...all(text, /\.form\('([^']+)'/gu).map((name) => `data-form="${name}"`),
    ...all(text, /\.on\('([^']+)'/gu).map((name) => `data-action="${name}"`),
    ...all(text, /\.part\('([^']+)'/gu).map((name) => `data-part="${name}"`),
    ...all(text, /showProblem\(view, '([^']+)'/gu).map((name) => `data-part="${name}"`),
    ...all(text, /\.list\(\s*'([^']+)'/gu).map((name) => `data-item="${name}"`),
    ...all(text, /form\.say\('([^']+)'/gu).map((name) => `data-message="${name}"`),
    ...all(text, /\.message\('([^']+)'/gu).map((name) => `data-message="${name}"`),
  ];
  for (const match of text.matchAll(/\.state\('([^']+)',\s*'([^']+)'\)/gu)) {
    selectors.push(`data-slot="${match[1] ?? ''}"`, `data-state="${match[2] ?? ''}"`);
  }
  for (const match of text.matchAll(/view\.say\('([^']+)',\s*'([^']+)'/gu)) {
    selectors.push(`data-part="${match[1] ?? ''}"`, `data-message="${match[2] ?? ''}"`);
  }
  return [...new Set(selectors)];
}

async function markup(id: string, fn: string): Promise<string> {
  const partials = all(body(fn), /\.include\('[^']+',\s*'([^']+)'\)/gu);
  const parts = await Promise.all([template(id), ...partials.map((name) => template(`_${name}`))]);
  return parts.join('\n');
}

describe('page templates', () => {
  const pages = renderers();

  it('finds the page functions to check', () => {
    expect(pages.length).toBeGreaterThan(40);
  });

  it.each(pages)('has everything the %s page function asks for', async (id, fn) => {
    const html = await markup(id, fn);
    for (const selector of expectedSelectors(fn)) {
      expect(html, `${id}.html is missing ${selector}`).toContain(selector);
    }
  });
});
