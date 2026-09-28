import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { shellHtml } from './shell.ts';

function shell(): string {
  return shellHtml({
    product_name: 'Example',
    locale: 'en-GB',
    base_path: '/',
    meta_origin: undefined,
    nonce: 'n1',
  });
}

describe('accessibility baseline', () => {
  it('sets a document language on <html> (WCAG 3.1.1)', () => {
    expect(shell()).toMatch(/<html\s+lang="[a-z]{2,3}(?:-[A-Z]{2})?"/);
  });

  it('sets a responsive viewport meta so text can scale (WCAG 1.4.10)', () => {
    expect(shell()).toContain('name="viewport" content="width=device-width, initial-scale=1"');
  });

  it('offers a skip link before the main landmark (WCAG 2.4.1)', () => {
    const html = shell();
    expect(html.indexOf('qtiauth-skip-link')).toBeLessThan(html.indexOf('id="qtiauth-main"'));
    expect(html).toContain('href="#qtiauth-main"');
  });

  it('gives <main> a stable id and tabindex so focus can move to it (WCAG 2.4.3)', () => {
    expect(shell()).toContain('id="qtiauth-main" tabindex="-1"');
  });

  it('declares a live region so client updates are announced (WCAG 4.1.3)', () => {
    expect(shell()).toContain('aria-live="polite"');
  });

  it('declares a color-scheme meta so browsers can render the dark theme', () => {
    expect(shell()).toContain('name="color-scheme"');
  });

  it('has app.js provide a visible page title before finishing bootstrap', async () => {
    const source = await readFile(join(import.meta.dirname, 'assets', 'app.js'), 'utf8');
    expect(source).toContain('aria-busy');
    expect(source).toContain('main.focus');
  });

  it('respects prefers-reduced-motion in the stylesheet (WCAG 2.3.3)', async () => {
    const css = await readFile(join(import.meta.dirname, 'assets', 'styles.css'), 'utf8');
    expect(css).toContain('prefers-reduced-motion: reduce');
  });

  it("keeps the min touch target above WCAG 2.5.8's 24×24 CSS pixels", async () => {
    const css = await readFile(join(import.meta.dirname, 'assets', 'styles.css'), 'utf8');
    const match = /min-height:\s*(\d+(?:\.\d+)?)rem;/.exec(css);
    expect(match).not.toBeNull();
    const rems = Number.parseFloat(match?.[1] ?? '0');
    expect(rems * 16).toBeGreaterThanOrEqual(24);
  });

  it('gives every interactive element a visible focus style (WCAG 2.4.7)', async () => {
    const css = await readFile(join(import.meta.dirname, 'assets', 'styles.css'), 'utf8');
    expect(css).toContain(':focus-visible');
    expect(css).toContain('outline:');
  });
});
