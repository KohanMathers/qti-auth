import { mkdtemp, readFile, readdir, rm, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { enforceRetention } from './retention.ts';

let dir: string | undefined;

afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('backup retention', () => {
  it('keeps recent backups and deletes anything older than the cutoff', async () => {
    dir = await mkdtemp(join(tmpdir(), 'qtiauth-backups-'));
    const oldAt = new Date('2026-08-01T00:00:00Z');
    const newAt = new Date('2026-09-27T00:00:00Z');
    await writeFile(join(dir, 'old.bak'), 'ciphertext');
    await utimes(join(dir, 'old.bak'), oldAt, oldAt);
    await writeFile(join(dir, 'new.bak'), 'ciphertext');
    await utimes(join(dir, 'new.bak'), newAt, newAt);

    const result = await enforceRetention({
      destination: { kind: 'directory', directory: dir },
      retention: 30 * 24 * 60 * 60 * 1000,
      now: new Date('2026-09-28T00:00:00Z'),
    });

    expect(result.deleted.map((entry) => entry.id)).toEqual(['old']);
    expect(result.kept.map((entry) => entry.id)).toEqual(['new']);
    const names = await readdir(dir);
    expect(names).toEqual(['new.bak']);
  });

  it('keeps at least the newest backup even when everything is expired', async () => {
    dir = await mkdtemp(join(tmpdir(), 'qtiauth-backups-'));
    const ancient = new Date('2020-01-01T00:00:00Z');
    await writeFile(join(dir, 'ancient.bak'), 'ciphertext');
    await utimes(join(dir, 'ancient.bak'), ancient, ancient);

    const result = await enforceRetention({
      destination: { kind: 'directory', directory: dir },
      retention: 30 * 24 * 60 * 60 * 1000,
      now: new Date('2026-09-28T00:00:00Z'),
    });

    expect(result.deleted).toEqual([]);
    expect(result.kept.map((entry) => entry.id)).toEqual(['ancient']);
    await readFile(join(dir, 'ancient.bak'));
  });
});
