import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_LOCALE, loadLocales, LocaleError, localeResponse } from './locale.ts';

async function stageLocales(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qtiauth-locales-'));
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(dir, name), body);
  }
  return dir;
}

describe('loadLocales', () => {
  let dir: string | undefined;
  beforeEach(() => {
    dir = undefined;
  });
  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  });

  it('loads every JSON catalogue and freezes each one', async () => {
    dir = await stageLocales({
      'en-GB.json': JSON.stringify({ 'nav.sign_in': 'Sign in' }),
      'cy-GB.json': JSON.stringify({ 'nav.sign_in': 'Mewngofnodi' }),
    });
    const set = await loadLocales(dir);
    expect([...set.keys()].sort()).toEqual(['cy-GB', 'en-GB']);
    expect(set.get('en-GB')?.['nav.sign_in']).toBe('Sign in');
    expect(Object.isFrozen(set.get('en-GB'))).toBe(true);
  });

  it('rejects a directory that does not ship the default locale', async () => {
    dir = await stageLocales({ 'fr-FR.json': '{}' });
    await expect(loadLocales(dir)).rejects.toBeInstanceOf(LocaleError);
  });

  it('rejects a filename that is not a canonical locale', async () => {
    dir = await stageLocales({ 'english.json': '{}', [`${DEFAULT_LOCALE}.json`]: '{}' });
    await expect(loadLocales(dir)).rejects.toBeInstanceOf(LocaleError);
  });

  it('rejects a value that is not a string', async () => {
    dir = await stageLocales({
      [`${DEFAULT_LOCALE}.json`]: JSON.stringify({ 'nav.sign_in': 3 }),
    });
    await expect(loadLocales(dir)).rejects.toBeInstanceOf(LocaleError);
  });
});

describe('localeResponse', () => {
  it('returns undefined for a locale that is not in the set', () => {
    const set = new Map([[DEFAULT_LOCALE, {}]]);
    expect(localeResponse(set, 'zz-ZZ')).toBeUndefined();
  });

  it('sets the content-language header to the resolved locale', () => {
    const set = new Map([[DEFAULT_LOCALE, { hello: 'Hello' }]]);
    const response = localeResponse(set, DEFAULT_LOCALE);
    expect(response?.headers.get('content-language')).toBe(DEFAULT_LOCALE);
  });
});
