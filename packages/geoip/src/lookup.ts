import { statSync } from 'node:fs';

import type { QtiauthConfig } from '@qtiauth/config';

import { DBIP_ATTRIBUTION, type GeoipAttribution, MAXMIND_ATTRIBUTION } from './attribution.ts';
import { type CountryRange, loadCountryCsv, lookupRange } from './csv.ts';
import { normalizeCountry, parseIp } from './ip.ts';
import { openMmdb, type MmdbLookup } from './mmdb.ts';

export type GeoipConfig = QtiauthConfig['geoip'];

export interface GeoIp {
  source: GeoipConfig['source'];
  available: boolean;
  attribution: GeoipAttribution | null;
  lookup: (ip: string) => string | null;
  close: () => void;
}

type Loaded =
  | { kind: 'csv'; ranges: CountryRange[]; mtime: number; path: string }
  | { kind: 'mmdb'; lookup: MmdbLookup; mtime: number; path: string; close: () => void };

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
    const opened = openMmdb(path);
    return { kind: 'mmdb', lookup: opened.lookup, close: opened.close, mtime, path };
  }
  return { kind: 'csv', ranges: loadCountryCsv(path), mtime, path };
}

export function openGeoIp(config: GeoipConfig): GeoIp {
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

  let loaded: Loaded | null = null;
  const ensure = (): Loaded | null => {
    const mtime = mtimeOf(config.database_path);
    if (mtime === null) {
      if (loaded?.kind === 'mmdb') loaded.close();
      loaded = null;
      return null;
    }
    if (loaded !== null && loaded.path === config.database_path && loaded.mtime === mtime) {
      return loaded;
    }
    if (loaded?.kind === 'mmdb') loaded.close();
    try {
      loaded = loadFile(config.database_path, mtime);
      return loaded;
    } catch {
      loaded = null;
      return null;
    }
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
      if (loaded?.kind === 'mmdb') loaded.close();
      loaded = null;
    },
  };
}

export function geoipAvailable(config: GeoipConfig): boolean {
  if (config.source === 'none') return false;
  if (config.source === 'header') return true;
  return mtimeOf(config.database_path) !== null;
}
