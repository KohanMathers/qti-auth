import { readFileSync } from 'node:fs';

import { type CountryResponse, Reader } from 'maxmind';

export type MmdbLookup = (ip: string) => string | null;

export interface OpenedMmdb {
  lookup: MmdbLookup;
}

export function openMmdb(path: string): OpenedMmdb {
  const reader = new Reader<CountryResponse>(readFileSync(path));
  return {
    lookup: (ip) => {
      const record = reader.get(ip);
      return record?.country?.iso_code ?? record?.registered_country?.iso_code ?? null;
    },
  };
}
