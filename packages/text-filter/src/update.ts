import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { untar } from './tar.ts';
import {
  formatWordList,
  LEGACY_LDNOOBW_FILE,
  LIST_FILES,
  parseWordList,
  stripLdnoobwSpaces,
  foldListWord,
} from './words.ts';
import { xlsxColumn } from './xlsx.ts';
import { unzip } from './zip.ts';

export const DEFAULT_LDNOOBW_COMMIT = '4638b970cb8d9d82789564fcba1f4a1eb508ff1a';
export const SCOWL_VERSION = '2020.12.07';

export const LDNOOBW_REPO = 'LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words';

export const LDNOOBW_LANGS = [
  'ar',
  'cs',
  'da',
  'de',
  'en',
  'eo',
  'es',
  'fa',
  'fi',
  'fil',
  'fr',
  'fr-CA-u-sd-caqc',
  'hi',
  'hu',
  'it',
  'ja',
  'kab',
  'ko',
  'nl',
  'no',
  'pl',
  'pt',
  'ru',
  'sv',
  'th',
  'tr',
  'zh',
] as const;

export const LIST_SOURCE_URLS = {
  ldnoobw: (commit: string, lang = 'en') =>
    `https://raw.githubusercontent.com/${LDNOOBW_REPO}/${commit}/${encodeURIComponent(lang)}`,
  scowl: `https://downloads.sourceforge.net/project/wordlist/SCOWL/${SCOWL_VERSION}/scowl-${SCOWL_VERSION}.tar.gz`,
  ssa: 'https://www.ssa.gov/oact/babynames/names.zip',
  onsBoys:
    'https://www.ons.gov.uk/file?uri=/peoplepopulationandcommunity/birthsdeathsandmarriages/livebirths/datasets/babynamesenglandandwalesbabynamesstatisticsboys/2022/boysnames2022.xlsx',
  onsGirls:
    'https://www.ons.gov.uk/file?uri=/peoplepopulationandcommunity/birthsdeathsandmarriages/livebirths/datasets/babynamesenglandandwalesbabynamesstatisticsgirls/2022/girlsnames2022.xlsx',
  surnames: 'https://www2.census.gov/topics/genealogy/1990surnames/dist.all.last',
  cities: 'https://download.geonames.org/export/dump/cities15000.zip',
  admin1: 'https://download.geonames.org/export/dump/admin1CodesASCII.txt',
} as const;

export class ListUpdateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ListUpdateError';
  }
}

export interface ListUpdateOptions {
  dir: string;
  ldnoobwCommit?: string;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
}

export interface ListUpdateResult {
  dir: string;
  ldnoobwCommit: string;
  counts: Record<keyof typeof LIST_FILES, number>;
}

type Fetcher = (url: string) => Promise<Uint8Array>;

function asText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function looksLikeHtml(bytes: Uint8Array): boolean {
  const start = asText(bytes.subarray(0, 256)).trimStart().slice(0, 32).toLowerCase();
  return start.startsWith('<!doctype html') || start.startsWith('<html');
}

async function defaultFetch(url: string): Promise<Uint8Array> {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: { 'user-agent': 'QTIAuth' },
  });
  if (!response.ok) {
    throw new ListUpdateError(`GET ${url} failed with ${String(response.status)}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const type = response.headers.get('content-type') ?? '';
  if (type.includes('text/html') || looksLikeHtml(bytes)) {
    throw new ListUpdateError(`GET ${url} returned HTML instead of the expected file`);
  }
  return bytes;
}

function makeFetcher(
  fetchImpl: ((url: string, init?: RequestInit) => Promise<Response>) | undefined,
): Fetcher {
  if (fetchImpl === undefined) return defaultFetch;
  return async (url) => {
    const response = await fetchImpl(url, { redirect: 'follow' });
    if (!response.ok) {
      throw new ListUpdateError(`GET ${url} failed with ${String(response.status)}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  };
}

function zipFiles(archive: Uint8Array, label: string): Map<string, Uint8Array> {
  try {
    return unzip(archive);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Broken zip archive';
    throw new ListUpdateError(`${label}: ${detail}`);
  }
}

function zipTexts(archive: Uint8Array, suffix: string, label: string): string[] {
  const texts: string[] = [];
  for (const [name, data] of zipFiles(archive, label)) {
    if (name.endsWith('/')) continue;
    if (suffix !== '' && !name.replaceAll('\\', '/').toLowerCase().endsWith(suffix.toLowerCase())) {
      continue;
    }
    texts.push(asText(data));
  }
  if (texts.length === 0) throw new ListUpdateError(`Zip archive had no ${suffix || 'files'}`);
  return texts;
}

function collect(words: Iterable<string>): Set<string> {
  const set = new Set<string>();
  for (const word of words) {
    const folded = foldListWord(word);
    if (folded !== '') set.add(folded);
  }
  return set;
}

function csvColumn(text: string, name: string): string[] {
  const lines = text.split(/\r?\n/).filter((line) => line !== '');
  const header = lines[0];
  if (header === undefined) return [];
  const columns = header
    .split(',')
    .map((column) => column.replaceAll('"', '').trim().toLowerCase());
  const index = columns.indexOf(name.toLowerCase());
  if (index < 0) return [];
  const values: string[] = [];
  for (const line of lines.slice(1)) {
    const value = (line.split(',')[index] ?? '').replaceAll('"', '').trim();
    if (value !== '') values.push(value);
  }
  return values;
}

function firstCsvColumn(text: string): string[] {
  const lines = text.split(/\r?\n/).filter((line) => line !== '');
  const start = lines[0]?.toLowerCase().includes('name') ? 1 : 0;
  const values: string[] = [];
  for (const line of lines.slice(start)) {
    const value = line.split(',')[0]?.replaceAll('"', '').trim() ?? '';
    if (value !== '' && /[a-zA-Z]/.test(value)) values.push(value);
  }
  return values;
}

function firstTokenColumn(text: string): string[] {
  const values: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const value = line.trim().split(/\s+/)[0] ?? '';
    if (value !== '' && /[a-zA-Z]/.test(value)) values.push(value);
  }
  return values;
}

function isZip(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b;
}

function xlsxNames(bytes: Uint8Array): string[] {
  try {
    return xlsxColumn(bytes, 'name');
  } catch {
    return [];
  }
}

function namesFromBytes(bytes: Uint8Array): string[] {
  if (isZip(bytes)) {
    const named = xlsxNames(bytes);
    return named.length > 0 ? named : firstCsvColumn(asText(bytes));
  }
  return firstCsvColumn(asText(bytes));
}

function surnamesFromBytes(bytes: Uint8Array): string[] {
  if (isZip(bytes)) {
    const named = xlsxNames(bytes);
    if (named.length > 0) return named;
    return zipTexts(bytes, '.csv', 'Census surnames').flatMap((text) => {
      const fromHeader = csvColumn(text, 'name');
      return fromHeader.length > 0 ? fromHeader : firstCsvColumn(text);
    });
  }
  const text = asText(bytes);
  const fromHeader = csvColumn(text, 'name');
  if (fromHeader.length > 0) return fromHeader;
  return firstTokenColumn(text);
}

function geonamesNames(text: string, nameIndex: number, asciiIndex: number): string[] {
  const names: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line === '' || line.startsWith('#')) continue;
    const cells = line.split('\t');
    const name = cells[nameIndex]?.trim() ?? '';
    const ascii = cells[asciiIndex]?.trim() ?? '';
    if (name !== '') names.push(name);
    if (ascii !== '' && ascii !== name) names.push(ascii);
  }
  return names;
}

function scowlWords(bytes: Uint8Array): string[] {
  const body = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
  try {
    const words: string[] = [];
    for (const [name, data] of untar(body)) {
      if (/(?:^|\/)final\/english-words\.(?:10|20|35|40|50|55|60|70)$/.test(name)) {
        words.push(...parseWordList(asText(data)));
      }
    }
    if (words.length > 0) return words;
  } catch {
    return parseWordList(asText(body));
  }
  return parseWordList(asText(body));
}

async function fetchLdnoobw(fetchBytes: Fetcher, commit: string): Promise<string[]> {
  const lists = await Promise.all(
    LDNOOBW_LANGS.map(async (lang) => {
      const url = LIST_SOURCE_URLS.ldnoobw(commit, lang);
      try {
        const text = asText(await fetchBytes(url));
        return parseWordList(text).map((word) => stripLdnoobwSpaces(word.toLowerCase()));
      } catch (error) {
        if (
          lang !== 'en' &&
          error instanceof ListUpdateError &&
          error.message.includes(' failed with 404')
        ) {
          return [];
        }
        throw error;
      }
    }),
  );
  return lists.flat();
}

async function existingHandList(dir: string, file: string): Promise<string[]> {
  try {
    return parseWordList(await readFile(join(dir, file), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function writeList(dir: string, file: string, words: Iterable<string>): Promise<number> {
  const unique = collect(words);
  await writeFile(join(dir, file), formatWordList(unique));
  return unique.size;
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export async function updateLists(options: ListUpdateOptions): Promise<ListUpdateResult> {
  const fetchBytes = makeFetcher(options.fetch);
  const commit = options.ldnoobwCommit ?? DEFAULT_LDNOOBW_COMMIT;
  if (!/^[0-9a-f]{7,40}$/i.test(commit)) {
    throw new ListUpdateError('--ldnoobw must be a git commit SHA');
  }
  await mkdir(options.dir, { recursive: true });

  const [ldnoobw, scowlArchive, ssaZip, onsBoys, onsGirls, surnameZip, citiesZip, admin1] =
    await Promise.all([
      fetchLdnoobw(fetchBytes, commit),
      fetchBytes(LIST_SOURCE_URLS.scowl),
      fetchBytes(LIST_SOURCE_URLS.ssa),
      fetchBytes(LIST_SOURCE_URLS.onsBoys),
      fetchBytes(LIST_SOURCE_URLS.onsGirls),
      fetchBytes(LIST_SOURCE_URLS.surnames),
      fetchBytes(LIST_SOURCE_URLS.cities),
      fetchBytes(LIST_SOURCE_URLS.admin1).then(asText),
    ]);

  const dictionary = scowlWords(scowlArchive);
  const names = [
    ...zipTexts(ssaZip, '.txt', 'SSA names.zip').flatMap((text) => firstCsvColumn(text)),
    ...namesFromBytes(onsBoys),
    ...namesFromBytes(onsGirls),
  ];
  const surnames = surnamesFromBytes(surnameZip);
  const places = [
    ...zipTexts(citiesZip, '.txt', 'GeoNames cities15000.zip').flatMap((text) =>
      geonamesNames(text, 1, 2),
    ),
    ...geonamesNames(admin1, 1, 2),
  ];

  const allow = await existingHandList(options.dir, LIST_FILES.allow);
  const extraBlock = await existingHandList(options.dir, LIST_FILES.extraBlock);

  const counts = {
    ldnoobw: await writeList(options.dir, LIST_FILES.ldnoobw, ldnoobw),
    dictionary: await writeList(options.dir, LIST_FILES.dictionary, dictionary),
    names: await writeList(options.dir, LIST_FILES.names, names),
    surnames: await writeList(options.dir, LIST_FILES.surnames, surnames),
    places: await writeList(options.dir, LIST_FILES.places, places),
    allow: await writeList(options.dir, LIST_FILES.allow, allow),
    extraBlock: await writeList(options.dir, LIST_FILES.extraBlock, extraBlock),
  };
  await unlinkIfPresent(join(options.dir, LEGACY_LDNOOBW_FILE));

  return { dir: options.dir, ldnoobwCommit: commit, counts };
}
