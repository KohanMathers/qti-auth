export const LIST_FILES = {
  ldnoobw: 'ldnoobw.txt',
  dictionary: 'dictionary.txt',
  names: 'names.txt',
  surnames: 'surnames.txt',
  places: 'places.txt',
  allow: 'allow.txt',
  extraBlock: 'extra-block.txt',
} as const;

export const LEGACY_LDNOOBW_FILE = 'ldnoobw-en.txt';

export const DEFAULT_LISTS_DIR = 'lists/username';

export function parseWordList(text: string): string[] {
  const words: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    words.push(trimmed);
  }
  return words;
}

export function formatWordList(words: Iterable<string>): string {
  return `${[...new Set(words)].toSorted((a, b) => a.localeCompare(b)).join('\n')}\n`;
}

export function stripLdnoobwSpaces(word: string): string {
  return word.replaceAll(' ', '');
}

export function foldListWord(word: string): string {
  return word
    .normalize('NFKC')
    .toLowerCase()
    .replaceAll(/[\s'.-]/g, '');
}
