import { type CliIo, run } from '@qtiauth/cli';
import { describe, expect, it } from 'vitest';

import { adminCreate } from './admin-create.ts';

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

describe('qtiauth admin create', () => {
  it('prints usage', async () => {
    const { io, out } = capture();
    expect(await run(['admin', 'create', '--help'], io, { 'admin create': adminCreate })).toBe(0);
    expect(out.stdout).toContain('Usage: qtiauth admin create');
    expect(out.stdout).toContain('--email');
  });

  it('requires --email', async () => {
    const { io, out } = capture();
    expect(await run(['admin', 'create'], io, { 'admin create': adminCreate })).toBe(2);
    expect(out.stderr).toContain('--email is required');
  });
});
