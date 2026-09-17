import { canonicalLocale, isCanonicalLocale } from '@qtiauth/email';

export { canonicalLocale, isCanonicalLocale };

export function preferredLocale(acceptLanguage: string | null): string | undefined {
  if (acceptLanguage === null) return undefined;
  const ranked = acceptLanguage
    .split(',')
    .map((part, index) => {
      const [tag = '', ...params] = part.trim().split(';');
      const q = params.map((param) => /^\s*q=([\d.]+)\s*$/.exec(param)?.[1]).find(Boolean);
      return { tag: tag.trim(), q: q === undefined ? 1 : Number(q), index };
    })
    .filter((entry) => entry.tag !== '' && entry.tag !== '*' && entry.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index);
  for (const entry of ranked) {
    const locale = canonicalLocale(entry.tag);
    if (locale !== undefined) return locale;
  }
  return undefined;
}
