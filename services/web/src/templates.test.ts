import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AssetSetError } from './assets.ts';
import { DEFAULT_TEMPLATES_DIR, loadTemplates } from './templates.ts';

async function stageTemplates(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qtiauth-templates-'));
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(dir, name), body);
  }
  return dir;
}

function bundleText(body: Uint8Array): string {
  return new TextDecoder().decode(body);
}

describe('loadTemplates', () => {
  let dir: string | undefined;
  beforeEach(() => {
    dir = undefined;
  });
  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  });

  it('wraps pages and partials in named template elements, sorted by file name', async () => {
    dir = await stageTemplates({
      'sign-up.html': '<h2>Up</h2>\n',
      '_ticket.html': '<p>Thread</p>\n',
      'account.html': '<h2>Account</h2>\n',
    });
    const text = bundleText((await loadTemplates(dir)).body);
    expect(text).toBe(
      '<template data-partial="ticket">\n<p>Thread</p>\n</template>\n' +
        '<template data-page="account">\n<h2>Account</h2>\n</template>\n' +
        '<template data-page="sign-up">\n<h2>Up</h2>\n</template>\n',
    );
  });

  it('serves the bundle as cacheable HTML', async () => {
    dir = await stageTemplates({ 'account.html': '<h2>Account</h2>' });
    const asset = await loadTemplates(dir);
    expect(asset.content_type).toBe('text/html; charset=utf-8');
    expect(asset.etag).toMatch(/^"[0-9a-f]{8}"$/);
  });

  it('skips files that are not HTML', async () => {
    dir = await stageTemplates({ 'account.html': '<h2>Account</h2>', 'README.md': '# Notes' });
    expect(bundleText((await loadTemplates(dir)).body)).not.toContain('Notes');
  });

  it('rejects a template name that is not lowercase', async () => {
    dir = await stageTemplates({ 'Account.html': '' });
    await expect(loadTemplates(dir)).rejects.toBeInstanceOf(AssetSetError);
  });

  it('rejects a directory with no templates', async () => {
    dir = await stageTemplates({ 'README.md': '' });
    await expect(loadTemplates(dir)).rejects.toBeInstanceOf(AssetSetError);
  });
});

const pages = (await import(
  pathToFileURL(new URL('./assets/pages.js', import.meta.url).pathname).toString()
)) as { PAGES: Record<string, unknown> };

describe('shipped page templates', () => {
  async function shipped(): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const name of await readdir(DEFAULT_TEMPLATES_DIR)) {
      if (!name.endsWith('.html')) continue;
      out.set(name, await readFile(join(DEFAULT_TEMPLATES_DIR, name), 'utf8'));
    }
    return out;
  }

  it('has one template per page and no template without a page', async () => {
    const names = [...(await shipped()).keys()].filter((name) => !name.startsWith('_'));
    expect(names.map((name) => name.slice(0, -'.html'.length)).sort()).toEqual(
      Object.keys(pages.PAGES).sort(),
    );
  });

  it('keeps scripts, inline handlers and inline styles out, since the CSP blocks them', async () => {
    for (const [name, html] of await shipped()) {
      expect(html, name).not.toMatch(/<script/iu);
      expect(html, name).not.toMatch(/\son[a-z]+\s*=/iu);
      expect(html, name).not.toMatch(/\sstyle\s*=/iu);
    }
  });

  it('owns its English copy, so no data-t key is shadowed by en-GB.json', async () => {
    const catalogue = JSON.parse(
      await readFile(join(import.meta.dirname, 'assets', 'locales', 'en-GB.json'), 'utf8'),
    ) as Record<string, string>;
    for (const [name, html] of await shipped()) {
      for (const match of html.matchAll(/data-t="([^"]+)"/gu)) {
        const key = match[1] ?? '';
        expect(catalogue[key], `${name} ${key}`).toBeUndefined();
      }
    }
  });
});
