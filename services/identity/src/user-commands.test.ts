import { type CliIo, run } from '@qtiauth/cli';
import { describe, expect, it } from 'vitest';

import { userDelete, userExport } from './user-commands.ts';

function capture() {
  const out = { stdout: '', stderr: '' };
  const io: CliIo = {
    stdout: (text) => {
      out.stdout += text;
    },
    stderr: (text) => {
      out.stderr += text;
    },
    env: {},
  };
  return { io, out };
}

describe('qtiauth user export', () => {
  it('prints usage', async () => {
    const { io, out } = capture();
    expect(await run(['user', 'export', '--help'], io, { 'user export': userExport })).toBe(0);
    expect(out.stdout).toContain('Usage: qtiauth user export');
  });

  it('requires a user id', async () => {
    const { io, out } = capture();
    expect(await run(['user', 'export'], io, { 'user export': userExport })).toBe(2);
    expect(out.stderr).toContain('A user id is required');
  });
});

describe('qtiauth user delete', () => {
  it('prints usage', async () => {
    const { io, out } = capture();
    expect(await run(['user', 'delete', '--help'], io, { 'user delete': userDelete })).toBe(0);
    expect(out.stdout).toContain('Usage: qtiauth user delete');
  });
});
