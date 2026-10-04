import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { LoadContext } from './data.ts';
import type { GatewayClient } from './gateway-client.ts';
import { clearRenderCache, renderPage } from './render.ts';

async function stage(name: string, body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qtiauth-render-'));
  await writeFile(join(dir, `${name}.html`), body);
  return dir;
}

function makeCtx(overrides: Partial<LoadContext> = {}): LoadContext {
  const gateway: GatewayClient = {
    get: () => Promise.resolve(null),
    fetch: () => Promise.resolve(new Response(null, { status: 404 })),
  };
  return {
    request: new Request('http://localhost/account'),
    config: {
      branding: { product_name: 'Example', company_name: 'Example Ltd' },
      cookies: { name: 'qtiauth_session', domain: null },
      surfaces: {},
    } as unknown as LoadContext['config'],
    params: {},
    gateway,
    query: new URLSearchParams(),
    ...overrides,
  };
}

const t = (_key: string, fallback: string): string => fallback;

describe('renderPage', () => {
  let dir: string | undefined;
  beforeEach(() => {
    clearRenderCache();
    dir = undefined;
  });
  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  });

  it('fills data-field placeholders with page data', async () => {
    dir = await stage('probe', '<div><span data-field="product_name">placeholder</span></div>');
    const html = await renderPage({ name: 'probe', ctx: makeCtx(), t, pagesDir: dir });
    expect(html).toContain('<span data-field="product_name">Example</span>');
  });

  it('resolves data-t attributes using the translator', async () => {
    dir = await stage('probe', '<h2 data-t="probe.title">Fallback</h2>');
    const html = await renderPage({
      name: 'probe',
      ctx: makeCtx(),
      t: (key, fallback) => (key === 'probe.title' ? 'Translated' : fallback),
      pagesDir: dir,
    });
    expect(html).toContain('<h2 data-t="probe.title">Translated</h2>');
  });

  it('drops elements whose data-show flag is falsy', async () => {
    dir = await stage(
      'probe',
      '<div><section data-show="visible">Shown</section><section data-show="hidden">Gone</section></div>',
    );
    const html = await renderPage({
      name: 'probe',
      ctx: makeCtx(),
      t,
      pagesDir: dir,
      data: { visible: true, hidden: false },
    });
    expect(html).toContain('Shown');
    expect(html).not.toContain('Gone');
  });

  it('iterates data-item templates over the matching array in page data', async () => {
    dir = await stage(
      'legal',
      '<ul data-slot="documents"><template data-item="documents"><li data-field="summary">x</li></template></ul>',
    );
    const html = await renderPage({
      name: 'legal',
      ctx: makeCtx(),
      t,
      pagesDir: dir,
      data: { documents: [{ summary: 'First' }, { summary: 'Second' }], documents_state: 'list' },
    });
    expect(html).toContain('<template');
    expect(html).toContain('First');
    expect(html).toContain('Second');
  });

  it('keeps the data-* wiring attributes in the output so client JS can enhance', async () => {
    dir = await stage(
      'probe',
      '<a href="/account" data-link><span data-field="product_name"></span></a>',
    );
    const html = await renderPage({ name: 'probe', ctx: makeCtx(), t, pagesDir: dir });
    expect(html).toContain('data-link');
    expect(html).toContain('data-field="product_name"');
  });
});
