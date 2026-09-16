import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Migration } from '@qtiauth/db';
import { startPostgres } from '@qtiauth/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { run } from './cli.ts';
import { migrateCommands } from './commands/migrate.ts';
import type { CliIo } from './io.ts';

let container: Awaited<ReturnType<typeof startPostgres>>;
let dir: string;
let config: string;

const migrations: Migration[] = [
  { name: '0001_first', up: () => Promise.resolve() },
  { name: '0002_second', up: () => Promise.resolve() },
];
const commands = migrateCommands({
  schema: 'identity',
  migrations: () => Promise.resolve(migrations),
});

async function qtiauth(...argv: string[]) {
  const out = { stdout: '', stderr: '' };
  const io: CliIo = {
    stdout: (text) => (out.stdout += text),
    stderr: (text) => (out.stderr += text),
    env: {},
  };
  return { code: await run(argv, io, commands), ...out };
}

beforeAll(async () => {
  container = await startPostgres();
  dir = await mkdtemp(join(tmpdir(), 'qtiauth-migrate-'));
  config = join(dir, 'qtiauth.yaml');
  await writeFile(
    config,
    [
      'database:',
      `  host: ${container.getHost()}`,
      `  port: ${String(container.getPort())}`,
      `  name: ${container.getDatabase()}`,
      '  roles:',
      `    identity: { user: ${container.getUsername()}, password: ${container.getPassword()} }`,
      '',
    ].join('\n'),
  );
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  await container.stop();
});

describe('qtiauth migrate', () => {
  it('shows status, applies pending migrations, then reports none pending', async () => {
    expect(await qtiauth('migrate', 'status', '-c', config)).toEqual({
      code: 0,
      stdout:
        'Schema identity: 0 applied, 2 pending\n  pending  0001_first\n  pending  0002_second\n',
      stderr: '',
    });

    expect(await qtiauth('migrate', 'up', '-c', config)).toEqual({
      code: 0,
      stdout: 'Applied 0001_first\nApplied 0002_second\nSchema identity is up to date.\n',
      stderr: '',
    });

    expect((await qtiauth('migrate', 'status', '-c', config)).stdout).toBe(
      'Schema identity: 2 applied, 0 pending\n  applied  0001_first\n  applied  0002_second\n',
    );
    expect((await qtiauth('migrate', 'up', '-c', config)).stdout).toBe(
      'Schema identity is up to date.\n',
    );
  });
});
