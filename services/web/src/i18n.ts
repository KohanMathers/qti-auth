import type { LocaleCatalogue, LocaleSet } from './locale.ts';
import { DEFAULT_LOCALE } from './locale.ts';

export interface LocaleRequest {
  request: Request;
  locales: LocaleSet;
}

export type Translator = (key: string, fallback: string) => string;

const COOKIE_NAME = 'qtiauth_locale';
const COOKIE_PATTERN = new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`);
const LOCALE_TOKEN = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2}|-[0-9]{3})?$/;

function fromCookie(header: string | null): string | undefined {
  if (header === null) return undefined;
  const match = COOKIE_PATTERN.exec(header);
  if (match === null) return undefined;
  const raw = decodeURIComponent(match[1] ?? '').trim();
  return LOCALE_TOKEN.test(raw) ? raw : undefined;
}

function fromAcceptLanguage(header: string | null, available: LocaleSet): string | undefined {
  if (header === null) return undefined;
  const tags = header
    .split(',')
    .map((entry) => (entry.split(';')[0] ?? '').trim())
    .filter((tag) => tag !== '');
  for (const tag of tags) {
    if (available.has(tag)) return tag;
    const [primary] = tag.split('-');
    if (primary !== undefined) {
      for (const name of available.keys()) {
        if (name.toLowerCase().startsWith(`${primary.toLowerCase()}-`)) return name;
      }
    }
  }
  return undefined;
}

export function resolveLocale(input: LocaleRequest): string {
  const cookie = fromCookie(input.request.headers.get('cookie'));
  if (cookie !== undefined && input.locales.has(cookie)) return cookie;
  const accept = fromAcceptLanguage(input.request.headers.get('accept-language'), input.locales);
  if (accept !== undefined) return accept;
  return DEFAULT_LOCALE;
}

export function translatorFor(catalogue: LocaleCatalogue | undefined): Translator {
  return (key, fallback) => {
    const value = catalogue?.[key];
    return value === undefined || value === '' ? fallback : value;
  };
}

export function catalogueFor(locales: LocaleSet, name: string): LocaleCatalogue {
  return locales.get(name) ?? locales.get(DEFAULT_LOCALE) ?? Object.freeze({});
}
