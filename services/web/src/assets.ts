import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const DEFAULT_ASSETS_DIR = join(import.meta.dirname, 'assets');

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

const ASSET_NAME = /^[a-z][a-z0-9._-]*$/;

export interface Asset {
  body: Uint8Array;
  content_type: string;
  etag: string;
}

export type AssetSet = ReadonlyMap<string, Asset>;

export class AssetSetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssetSetError';
  }
}

function contentTypeFor(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot < 0) throw new AssetSetError(`Asset ${name} has no extension`);
  const type = CONTENT_TYPES[name.slice(dot)];
  if (type === undefined) throw new AssetSetError(`Asset ${name} has no known content type`);
  return type;
}

function etagFor(body: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (const byte of body) {
    hash = Math.imul(hash ^ byte, 0x01000193);
  }
  return `"${(hash >>> 0).toString(16).padStart(8, '0')}"`;
}

export async function loadAssets(dir: string = DEFAULT_ASSETS_DIR): Promise<AssetSet> {
  const entries = await readdir(dir, { withFileTypes: true });
  const set = new Map<string, Asset>();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!ASSET_NAME.test(entry.name)) {
      throw new AssetSetError(`Asset ${entry.name} must be lowercase, numbers, . _ or -`);
    }
    const body = await readFile(join(dir, entry.name));
    set.set(entry.name, {
      body,
      content_type: contentTypeFor(entry.name),
      etag: etagFor(body),
    });
  }
  return set;
}

export function assetResponse(asset: Asset, request: Request): Response {
  if (request.headers.get('if-none-match') === asset.etag) {
    return new Response(null, { status: 304, headers: { etag: asset.etag } });
  }
  return new Response(asset.body, {
    status: 200,
    headers: {
      'content-type': asset.content_type,
      'cache-control': 'public, max-age=300, must-revalidate',
      etag: asset.etag,
    },
  });
}
