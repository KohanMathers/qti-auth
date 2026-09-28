import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const DEFAULT_LOCALE = 'en-GB';
export const DEFAULT_LOCALES_DIR = join(import.meta.dirname, 'assets', 'locales');

const LOCALE = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2}|-[0-9]{3})?$/;

export type LocaleCatalogue = Readonly<Record<string, string>>;
export type LocaleSet = ReadonlyMap<string, LocaleCatalogue>;

export class LocaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocaleError';
  }
}

function parseCatalogue(name: string, body: string): LocaleCatalogue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new LocaleError(`Locale ${name} is not valid JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new LocaleError(`Locale ${name} must be a JSON object`);
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') {
      throw new LocaleError(`Locale ${name} value for ${key} must be a string`);
    }
    out[key] = value;
  }
  return Object.freeze(out);
}

export async function loadLocales(dir: string = DEFAULT_LOCALES_DIR): Promise<LocaleSet> {
  const entries = await readdir(dir, { withFileTypes: true });
  const set = new Map<string, LocaleCatalogue>();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const name = entry.name.slice(0, -'.json'.length);
    if (!LOCALE.test(name)) {
      throw new LocaleError(`Locale filename ${entry.name} is not a canonical locale like en-GB`);
    }
    const body = await readFile(join(dir, entry.name), 'utf8');
    set.set(name, parseCatalogue(name, body));
  }
  if (!set.has(DEFAULT_LOCALE)) {
    throw new LocaleError(`Default locale ${DEFAULT_LOCALE} is missing from ${dir}`);
  }
  return set;
}

export function localeResponse(locales: LocaleSet, name: string): Response | undefined {
  const catalogue = locales.get(name);
  if (catalogue === undefined) return undefined;
  return new Response(JSON.stringify(catalogue), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=300, must-revalidate',
      'content-language': name,
    },
  });
}
