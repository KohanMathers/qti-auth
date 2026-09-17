import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { sections } from '@qtiauth/config';
import { describe, expect, it } from 'vitest';

import { DBIP_ATTRIBUTION } from './attribution.ts';
import { openGeoIp, RECHECK_INTERVAL_MS } from './lookup.ts';

const CSV = `"1.0.0.0","1.0.0.255","AU"
"8.8.8.0","8.8.8.255","US"
"2001:4860::","2001:4860:ffff:ffff:ffff:ffff:ffff:ffff","US"
`;

function csvFile(name: string, contents: Buffer | string): string {
  const dir = mkdtempSync(join(tmpdir(), 'qtiauth-geoip-'));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, contents);
  return path;
}

describe('openGeoIp', () => {
  it('looks up countries from a DB-IP Lite CSV', () => {
    const geoip = openGeoIp(
      sections.geoip.parse({
        source: 'dbip_lite',
        database_path: csvFile('dbip.csv', CSV),
      }),
    );
    expect(geoip.available).toBe(true);
    expect(geoip.attribution).toEqual(DBIP_ATTRIBUTION);
    expect(geoip.lookup('1.0.0.1')).toBe('AU');
    expect(geoip.lookup('8.8.8.8')).toBe('US');
    expect(geoip.lookup('2001:4860:4860::8888')).toBe('US');
    expect(geoip.lookup('9.9.9.9')).toBeNull();
    geoip.close();
  });

  it('reads a gzipped CSV', () => {
    const geoip = openGeoIp(
      sections.geoip.parse({
        source: 'dbip_lite',
        database_path: csvFile('dbip.csv.gz', gzipSync(CSV)),
      }),
    );
    expect(geoip.lookup('1.0.0.2')).toBe('AU');
    geoip.close();
  });

  it('is unavailable when the database is missing and when source is none', () => {
    const missing = openGeoIp(
      sections.geoip.parse({
        source: 'dbip_lite',
        database_path: join(tmpdir(), 'qtiauth-missing-geoip.csv'),
      }),
    );
    expect(missing.available).toBe(false);
    expect(missing.lookup('1.1.1.1')).toBeNull();
    missing.close();

    const none = openGeoIp(sections.geoip.parse({ source: 'none' }));
    expect(none.available).toBe(false);
    expect(none.attribution).toBeNull();
    none.close();
  });

  it('does not look up when the source is a header', () => {
    const geoip = openGeoIp(sections.geoip.parse({ source: 'header', header: 'cf-ipcountry' }));
    expect(geoip.available).toBe(true);
    expect(geoip.lookup('1.0.0.1')).toBeNull();
    geoip.close();
  });

  it('parses a broken database once and reports the error', () => {
    const path = csvFile('dbip.csv.gz', Buffer.from([0x1f, 0x8b, 0x00, 0x01]));
    const errors: unknown[] = [];
    let clock = 0;
    const geoip = openGeoIp(sections.geoip.parse({ source: 'dbip_lite', database_path: path }), {
      onError: (error) => errors.push(error),
      now: () => clock,
    });
    expect(geoip.lookup('1.0.0.1')).toBeNull();
    clock += RECHECK_INTERVAL_MS * 3;
    expect(geoip.lookup('1.0.0.1')).toBeNull();
    expect(geoip.available).toBe(false);
    expect(errors).toHaveLength(1);
    geoip.close();
  });

  it('re-reads the database only after the recheck interval', () => {
    const path = csvFile('dbip.csv', CSV);
    let clock = 0;
    const geoip = openGeoIp(sections.geoip.parse({ source: 'dbip_lite', database_path: path }), {
      now: () => clock,
    });
    expect(geoip.lookup('1.0.0.1')).toBe('AU');

    writeFileSync(path, `"1.0.0.0","1.0.0.255","NZ"\n`);
    expect(geoip.lookup('1.0.0.1')).toBe('AU');
    clock += RECHECK_INTERVAL_MS;
    expect(geoip.lookup('1.0.0.1')).toBe('NZ');
    geoip.close();
  });
});
