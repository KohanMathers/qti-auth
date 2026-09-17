import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LIST_FILES } from '@qtiauth/text-filter';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { run } from '../cli.ts';
import type { CliIo } from '../io.ts';

function capture() {
  const out = { stdout: '', stderr: '' };
  const io: CliIo = {
    stdout: (text) => (out.stdout += text),
    stderr: (text) => (out.stderr += text),
    env: {},
  };
  return { io, out };
}

let dir: string;
let config: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'qtiauth-lists-cli-'));
  config = join(dir, 'qtiauth.yaml');
  await writeFile(config, 'text_filter:\n  lists_dir: lists/username\n');
  const lists = join(dir, 'lists/username');
  await mkdir(lists, { recursive: true });
  await writeFile(join(lists, LIST_FILES.ldnoobw), 'cunt\nslurword\n');
  await writeFile(join(lists, LIST_FILES.dictionary), 'classic\nscunthorpe\n');
  await writeFile(join(lists, LIST_FILES.names), '');
  await writeFile(join(lists, LIST_FILES.surnames), '');
  await writeFile(join(lists, LIST_FILES.places), '');
  await writeFile(join(lists, LIST_FILES.allow), '');
  await writeFile(join(lists, LIST_FILES.extraBlock), '');
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('qtiauth lists audit', () => {
  it('prints dictionary words that contain a blocked substring', async () => {
    const { io, out } = capture();
    expect(await run(['lists', 'audit', '--config', config], io)).toBe(0);
    expect(out.stdout).toContain('scunthorpe\tcunt');
    expect(out.stdout).not.toContain('classic');
  });

  it('prints usage', async () => {
    const { io, out } = capture();
    expect(await run(['lists', 'audit', '--help'], io)).toBe(0);
    expect(out.stdout).toContain('Usage: qtiauth lists audit');
  });
});

describe('qtiauth lists update', () => {
  it('prints usage', async () => {
    const { io, out } = capture();
    expect(await run(['lists', 'update', '--help'], io)).toBe(0);
    expect(out.stdout).toContain('Usage: qtiauth lists update');
    expect(out.stdout).toContain('--ldnoobw');
  });

  it('rejects a commit that is not a SHA', async () => {
    const { io, out } = capture();
    expect(await run(['lists', 'update', '--config', config, '--ldnoobw', 'HEAD'], io)).toBe(1);
    expect(out.stderr).toContain('--ldnoobw must be a git commit SHA');
  });
});
