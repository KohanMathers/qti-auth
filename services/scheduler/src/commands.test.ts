import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CliIo } from '@qtiauth/cli';
import { serviceCommands } from '@qtiauth/service-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { jobsList, jobsListCommand } from './commands.ts';
import { definition, router } from './service.ts';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'qtiauth-scheduler-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function capture() {
  const out = { stdout: '', stderr: '' };
  const io: CliIo = {
    stdout: (text) => (out.stdout += text),
    stderr: (text) => (out.stderr += text),
    env: {},
  };
  return { io, out };
}

describe('qtiauth jobs list', () => {
  it('is one of the scheduler image commands', () => {
    expect(Object.keys(serviceCommands(definition, router, { 'jobs list': jobsList }))).toContain(
      'jobs list',
    );
  });

  it('prints every job and when it next ticks', async () => {
    const path = join(dir, 'qtiauth.yaml');
    await writeFile(
      path,
      [
        'scheduler:',
        '  timezone: Europe/London',
        '  jobs:',
        "    retention.sweep: { schedule: '0 1 * * *' }",
        '    steam.ownership_sync: { enabled: false }',
        '',
      ].join('\n'),
    );
    const { io, out } = capture();

    const status = await jobsListCommand(() => Date.parse('2026-09-16T12:00:00Z'))(
      ['--config', path],
      io,
    );

    expect(status).toBe(0);
    const printed = JSON.parse(out.stdout) as {
      timezone: string;
      jobs: { name: string; next_run: string | null }[];
    };
    expect(printed.timezone).toBe('Europe/London');
    expect(printed.jobs).toContainEqual({
      name: 'retention.sweep',
      schedule: '0 1 * * *',
      enabled: true,
      next_run: '2026-09-17T00:00:00.000Z',
    });
    expect(printed.jobs).toContainEqual({
      name: 'steam.ownership_sync',
      schedule: '0 5 * * *',
      enabled: false,
      next_run: null,
    });
    expect(printed.jobs).toHaveLength(20);
  });

  it('prints its usage', async () => {
    const { io, out } = capture();
    expect(await jobsList(['--help'], io)).toBe(0);
    expect(out.stdout).toContain('Usage: qtiauth jobs list');
  });
});
