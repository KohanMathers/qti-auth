import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { assetResponse, AssetSetError, DEFAULT_ASSETS_DIR, loadAssets } from './assets.ts';

async function stageAssets(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qtiauth-assets-'));
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(dir, name), body);
  }
  return dir;
}

describe('loadAssets', () => {
  let dir: string | undefined;
  beforeEach(() => {
    dir = undefined;
  });
  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  });

  it('picks the content type from the file extension', async () => {
    dir = await stageAssets({ 'app.js': 'export {};', 'styles.css': 'body {}' });
    const set = await loadAssets(dir);
    expect(set.get('app.js')?.content_type).toBe('application/javascript; charset=utf-8');
    expect(set.get('styles.css')?.content_type).toBe('text/css; charset=utf-8');
  });

  it('computes a stable etag from the file content', async () => {
    dir = await stageAssets({ 'app.js': 'let one = 1;' });
    const first = await loadAssets(dir);
    const second = await loadAssets(dir);
    expect(first.get('app.js')?.etag).toBe(second.get('app.js')?.etag);
    expect(first.get('app.js')?.etag).toMatch(/^"[0-9a-f]{8}"$/);
  });

  it('rejects an unknown extension', async () => {
    dir = await stageAssets({ 'app.wat': 'binary' });
    await expect(loadAssets(dir)).rejects.toBeInstanceOf(AssetSetError);
  });

  it('skips TypeScript declarations, which describe the scripts and are not served', async () => {
    dir = await stageAssets({ 'app.js': 'export {};', 'app.d.ts': 'export {};' });
    const set = await loadAssets(dir);
    expect([...set.keys()]).toEqual(['app.js']);
  });

  it('loads the assets the service ships', async () => {
    const set = await loadAssets(DEFAULT_ASSETS_DIR);
    expect(set.has('pages.js')).toBe(true);
  });

  it('rejects a filename that is not lowercase asset-safe', async () => {
    dir = await stageAssets({ 'App.js': '' });
    await expect(loadAssets(dir)).rejects.toBeInstanceOf(AssetSetError);
  });
});

describe('assetResponse', () => {
  const asset = {
    body: new TextEncoder().encode('body{}'),
    content_type: 'text/css; charset=utf-8',
    etag: '"abcdef01"',
  };

  it('returns the asset body with a public cache-control header', () => {
    const response = assetResponse(asset, new Request('https://example.test/styles.css'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('public');
    expect(response.headers.get('etag')).toBe(asset.etag);
  });

  it('serves 304 Not Modified when the request etag matches', () => {
    const request = new Request('https://example.test/styles.css', {
      headers: { 'if-none-match': asset.etag },
    });
    const response = assetResponse(asset, request);
    expect(response.status).toBe(304);
  });
});
