import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { type Asset, AssetSetError, assetFrom, DEFAULT_ASSETS_DIR } from './assets.ts';

export const DEFAULT_TEMPLATES_DIR = join(DEFAULT_ASSETS_DIR, 'pages');

const TEMPLATE_NAME = /^_?[a-z][a-z0-9-]*\.html$/;

export async function loadTemplates(dir: string = DEFAULT_TEMPLATES_DIR): Promise<Asset> {
  const entries = await readdir(dir, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.html'))
    .map((entry) => entry.name)
    .sort();
  const parts: string[] = [];
  for (const name of names) {
    if (!TEMPLATE_NAME.test(name)) {
      throw new AssetSetError(`Template ${name} must be lowercase, numbers or -`);
    }
    const partial = name.startsWith('_');
    const id = name.slice(partial ? 1 : 0, -'.html'.length);
    const body = await readFile(join(dir, name), 'utf8');
    parts.push(`<template data-${partial ? 'partial' : 'page'}="${id}">\n${body}</template>\n`);
  }
  if (parts.length === 0) throw new AssetSetError(`No page templates in ${dir}`);
  return assetFrom('templates.html', new TextEncoder().encode(parts.join('')));
}
