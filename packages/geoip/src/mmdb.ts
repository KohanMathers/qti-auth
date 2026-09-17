import { Reader, type CountryResponse } from 'maxmind';
import { readFileSync } from 'node:fs';

export type MmdbLookup = (ip: string) => string | null;

export interface OpenedMmdb {
  lookup: MmdbLookup;
  close: () => void;
}

export function openMmdb(path: string): OpenedMmdb {
  const reader = new Reader<CountryResponse>(readFileSync(path));
  return {
    lookup: (ip) => {
      const record = reader.get(ip);
      return record?.country?.iso_code ?? record?.registered_country?.iso_code ?? null;
    },
    close: () => undefined,
  };
}
