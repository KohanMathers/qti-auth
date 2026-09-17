import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { normalize } from './normalize.ts';
import { DEFAULT_LISTS_DIR, LEGACY_LDNOOBW_FILE, LIST_FILES, parseWordList } from './words.ts';

export { DEFAULT_LISTS_DIR, LIST_FILES };

export function resolveListsDir(configPath: string, listsDir: string): string {
  return resolve(dirname(configPath), listsDir);
}

export interface WordLists {
  allow: Set<string>;
  blockExact: Set<string>;
  blockLoose: Set<string>;
  blockExtra: Set<string>;
  dictionary: Set<string>;
  dictionaryEnglish: Set<string>;
}

export interface LoadedLists extends WordLists {
  dir: string;
}

function loadWords(text: string): string[] {
  return parseWordList(text)
    .map((word) => normalize(word))
    .filter((word) => word !== '');
}

async function readWords(dir: string, file: string): Promise<string[]> {
  try {
    return loadWords(await readFile(join(dir, file), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function readLdnoobw(dir: string): Promise<string[]> {
  const [current, legacy] = await Promise.all([
    readWords(dir, LIST_FILES.ldnoobw),
    readWords(dir, LEGACY_LDNOOBW_FILE),
  ]);
  return [...new Set([...current, ...legacy])];
}

export function deriveBlocklists(
  ldnoobw: Iterable<string>,
  dictionaryEnglish: ReadonlySet<string>,
): { blockExact: Set<string>; blockLoose: Set<string> } {
  const blockExact = new Set<string>();
  const blockLoose = new Set<string>();
  for (const word of ldnoobw) {
    if (word.length <= 3 || dictionaryEnglish.has(word)) blockExact.add(word);
    else blockLoose.add(word);
  }
  return { blockExact, blockLoose };
}

export function emptyWordLists(): WordLists {
  return {
    allow: new Set(),
    blockExact: new Set(),
    blockLoose: new Set(),
    blockExtra: new Set(),
    dictionary: new Set(),
    dictionaryEnglish: new Set(),
  };
}

export async function loadWordLists(dir: string): Promise<LoadedLists> {
  const [ldnoobw, dictionaryEnglish, names, surnames, places, allow, extraBlock] =
    await Promise.all([
      readLdnoobw(dir),
      readWords(dir, LIST_FILES.dictionary),
      readWords(dir, LIST_FILES.names),
      readWords(dir, LIST_FILES.surnames),
      readWords(dir, LIST_FILES.places),
      readWords(dir, LIST_FILES.allow),
      readWords(dir, LIST_FILES.extraBlock),
    ]);
  const english = new Set(dictionaryEnglish);
  const dictionary = new Set([...english, ...names, ...surnames, ...places]);
  const { blockExact, blockLoose } = deriveBlocklists(ldnoobw, english);
  return {
    dir,
    allow: new Set(allow),
    blockExact,
    blockLoose,
    blockExtra: new Set(extraBlock),
    dictionary,
    dictionaryEnglish: english,
  };
}

export function blockSet(lists: WordLists): Set<string> {
  return new Set([...lists.blockExact, ...lists.blockLoose, ...lists.blockExtra]);
}
