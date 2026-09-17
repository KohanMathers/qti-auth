import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

import { parseIp } from './ip.ts';

export interface CountryRange {
  start: bigint;
  end: bigint;
  country: string;
}

const QUOTED = /^"(.*)"$/;

function cell(raw: string): string {
  const trimmed = raw.trim();
  const quoted = QUOTED.exec(trimmed);
  return quoted?.[1] ?? trimmed;
}

export function parseCountryCsv(text: string): CountryRange[] {
  const ranges: CountryRange[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '' || line.startsWith('#')) continue;
    const parts = line.split(',');
    if (parts.length < 3) continue;
    const start = parseIp(cell(parts[0] ?? ''));
    const end = parseIp(cell(parts[1] ?? ''));
    const country = cell(parts[2] ?? '').toUpperCase();
    if (start === null || end === null || country.length !== 2) continue;
    ranges.push({ start, end, country });
  }
  ranges.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  return ranges;
}

export function lookupRange(ranges: readonly CountryRange[], ip: bigint): string | null {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const range = ranges[mid];
    if (range === undefined) return null;
    if (ip < range.start) high = mid - 1;
    else if (ip > range.end) low = mid + 1;
    else return range.country;
  }
  return null;
}

export function loadCountryCsv(path: string): CountryRange[] {
  const raw = readFileSync(path);
  const gzipped = raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b;
  const text = (gzipped ? gunzipSync(raw) : raw).toString('utf8');
  return parseCountryCsv(text);
}
