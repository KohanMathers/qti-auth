export function canonicalLocale(value: string): string | undefined {
  try {
    return Intl.getCanonicalLocales(value)[0];
  } catch {
    return undefined;
  }
}

export function isCanonicalLocale(value: string): boolean {
  return canonicalLocale(value) === value;
}
