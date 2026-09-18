import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMemoryStore } from '@qtiauth/storage';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ledgerDestination,
  ledgerKeepUntil,
  LEDGER_EXTRA_RETENTION,
  pruneLedgerDestination,
} from './ledger.ts';

let dir: string | undefined;

afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
});

describe('deletion ledger', () => {
  it('keeps entries for backup retention plus 30 days', () => {
    const now = new Date('2026-09-18T00:00:00Z');
    expect(ledgerKeepUntil(35 * 24 * 60 * 60 * 1000, now).toISOString()).toBe(
      new Date(now.getTime() - 35 * 24 * 60 * 60 * 1000 - LEDGER_EXTRA_RETENTION).toISOString(),
    );
  });

  it('writes to a directory destination and prunes storage objects by age', async () => {
    dir = await mkdtemp(join(tmpdir(), 'qtiauth-ledger-'));
    expect(
      ledgerDestination({ destination: 'directory', directory: dir, retention: 1 }, null),
    ).toEqual({ kind: 'directory', directory: dir });
    let now = new Date('2020-01-01T00:00:00Z');
    const store = createMemoryStore(() => now);
    await store.put(
      'deletion-ledger/old.json',
      new TextEncoder().encode('{"user_id":"u1","deleted_at":"2020-01-01T00:00:00.000Z"}\n'),
      'application/json',
    );
    now = new Date('2026-09-18T00:00:00Z');
    await store.put(
      'deletion-ledger/new.json',
      new TextEncoder().encode('{"user_id":"u2","deleted_at":"2026-09-18T00:00:00.000Z"}\n'),
      'application/json',
    );
    const pruned = await pruneLedgerDestination(
      { kind: 'storage', store },
      new Date('2026-08-01T00:00:00Z'),
    );
    expect(pruned).toBe(1);
    expect(await store.get('deletion-ledger/old.json')).toBeUndefined();
    expect(await store.get('deletion-ledger/new.json')).toBeDefined();
  });

  it('prunes directory entries by when they were written', async () => {
    dir = await mkdtemp(join(tmpdir(), 'qtiauth-ledger-'));
    const ledgerDir = join(dir, 'deletion-ledger');
    await mkdir(ledgerDir);
    const old = join(ledgerDir, 'old.json');
    await writeFile(old, '{"user_id":"u1","deleted_at":"2020-01-01T00:00:00.000Z"}\n');
    await utimes(old, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
    await writeFile(join(ledgerDir, 'new.json'), '{"user_id":"u2"}\n');
    const pruned = await pruneLedgerDestination(
      { kind: 'directory', directory: dir },
      new Date('2026-08-01T00:00:00Z'),
    );
    expect(pruned).toBe(1);
  });

  it('refuses a storage destination without a store', () => {
    expect(() =>
      ledgerDestination({ destination: 'storage', directory: '/tmp', retention: 1 }, null),
    ).toThrow(/storage is not enabled/);
  });
});
