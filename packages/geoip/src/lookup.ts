import { statSync } from 'node:fs';

import type { QtiauthConfig } from '@qtiauth/config';

import { DBIP_ATTRIBUTION, type GeoipAttribution, MAXMIND_ATTRIBUTION } from './attribution.ts';
import { type CountryRange, loadCountryCsv, lookupRange } from './csv.ts';
import { normalizeCountry, parseIp } from './ip.ts';
import { openMmdb, type MmdbLookup } from './mmdb.ts';

export type GeoipConfig = QtiauthConfig['geoip'];

/** How long a stat of the database file is trusted before checking for a newer one. */
export const RECHECK_INTERVAL_MS = 30_000;

export interface GeoipOptions {
  /** Called once per failed load, so a broken database does not fail silently. */
  onError?: (error: unknown, path: string) => void;
  now?: () => number;
}

export interface GeoIp {
  source: GeoipConfig['source'];
  available: boolean;
  attribution: GeoipAttribution | null;
  lookup: (ip: string) => string | null;
  close: () => void;
}

type Loaded =
  | { kind: 'csv'; ranges: CountryRange[]; mtime: number; path: string }
  | { kind: 'mmdb'; lookup: MmdbLookup; mtime: number; path: string };

function mtimeOf(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function isMmdb(path: string): boolean {
  return path.endsWith('.mmdb');
}

function attributionFor(source: GeoipConfig['source']): GeoipAttribution | null {
  if (source === 'dbip_lite') return DBIP_ATTRIBUTION;
  if (source === 'maxmind') return MAXMIND_ATTRIBUTION;
  return null;
}

function loadFile(path: string, mtime: number): Loaded {
  if (isMmdb(path)) {
    return { kind: 'mmdb', lookup: openMmdb(path).lookup, mtime, path };
  }
  return { kind: 'csv', ranges: loadCountryCsv(path), mtime, path };
}

export function openGeoIp(config: GeoipConfig, options: GeoipOptions = {}): GeoIp {
  const attribution = attributionFor(config.source);
  if (config.source === 'none' || config.source === 'header') {
    return {
      source: config.source,
      available: config.source === 'header',
      attribution,
      lookup: () => null,
      close: () => undefined,
    };
  }

  const now = options.now ?? Date.now;
  let loaded: Loaded | null = null;
  // The file that failed to load, so a corrupt database is parsed once rather
  // than on every lookup.
  let failed: { path: string; mtime: number } | null = null;
  let checkedAt: number | null = null;

  const isCurrent = (candidate: { path: string; mtime: number }, mtime: number): boolean =>
    candidate.path === config.database_path && candidate.mtime === mtime;

  const ensure = (): Loaded | null => {
    const time = now();
    if (checkedAt !== null && time - checkedAt < RECHECK_INTERVAL_MS) return loaded;
    checkedAt = time;
    const mtime = mtimeOf(config.database_path);
    if (mtime === null) {
      loaded = null;
      return null;
    }
    if (loaded !== null && isCurrent(loaded, mtime)) return loaded;
    if (failed !== null && isCurrent(failed, mtime)) {
      loaded = null;
      return null;
    }
    try {
      loaded = loadFile(config.database_path, mtime);
      failed = null;
    } catch (error) {
      loaded = null;
      failed = { path: config.database_path, mtime };
      options.onError?.(error, config.database_path);
    }
    return loaded;
  };

  return {
    source: config.source,
    get available() {
      return ensure() !== null;
    },
    attribution,
    lookup: (ip) => {
      const file = ensure();
      if (file === null) return null;
      if (file.kind === 'mmdb') return normalizeCountry(file.lookup(ip));
      const value = parseIp(ip);
      if (value === null) return null;
      return normalizeCountry(lookupRange(file.ranges, value));
    },
    close: () => {
      loaded = null;
      failed = null;
      checkedAt = null;
    },
  };
}
