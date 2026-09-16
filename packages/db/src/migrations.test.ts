import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadMigrations, type Migration, MigrationError, planMigrations } from './migrations.ts';

const migration = (name: string): Migration => ({ name, up: () => Promise.resolve() });

describe('planMigrations', () => {
  const migrations = ['0001_a', '0002_b', '0003_c'].map(migration);

  it('splits migrations into applied and pending', () => {
    expect(planMigrations(migrations, ['0001_a'])).toEqual({
      applied: ['0001_a'],
      pending: ['0002_b', '0003_c'],
      unknown: [],
    });
  });

  it('reports migrations applied by a newer release as unknown', () => {
    expect(planMigrations(migrations.slice(0, 2), ['0003_c', '0001_a', '0002_b'])).toEqual({
      applied: ['0001_a', '0002_b'],
      pending: [],
      unknown: ['0003_c'],
    });
  });

  it('rejects duplicate or unordered names', () => {
    expect(() => planMigrations(['0001_a', '0001_a'].map(migration), [])).toThrow(MigrationError);
    expect(() => planMigrations(['0002_b', '0001_a'].map(migration), [])).toThrow(
      'Migrations must have unique names in ascending order: 0001_a comes after 0002_b',
    );
  });

  it('refuses a pending migration that sorts before an applied one', () => {
    expect(() => planMigrations(migrations, ['0001_a', '0003_c'])).toThrow(
      'Migration 0002_b is pending but sorts before 0003_c, which is already applied.',
    );
  });
});

describe('loadMigrations', () => {
  it('imports .ts files in name order, skipping tests', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qtiauth-migrations-'));
    try {
      const up = 'export async function up() {}\n';
      await writeFile(join(dir, '0002_second.ts'), up);
      await writeFile(join(dir, '0001_first.ts'), up);
      await writeFile(join(dir, '0001_first.test.ts'), up);
      await writeFile(join(dir, 'README.md'), 'notes\n');

      const loaded = await loadMigrations(dir);
      expect(loaded.map((m) => m.name)).toEqual(['0001_first', '0002_second']);
      expect(typeof loaded[0]?.up).toBe('function');

      await writeFile(join(dir, '0003_broken.ts'), 'export const down = 1;\n');
      await expect(loadMigrations(dir)).rejects.toThrow(
        'Migration 0003_broken.ts must export an up function',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
