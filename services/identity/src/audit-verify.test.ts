import { type CliIo, run } from '@qtiauth/cli';
import { describe, expect, it } from 'vitest';

import { auditVerify } from './audit-verify.ts';

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

describe('qtiauth audit verify', () => {
  it('prints usage', async () => {
    const { io, out } = capture();
    expect(await run(['audit', 'verify', '--help'], io, { 'audit verify': auditVerify })).toBe(0);
    expect(out.stdout).toContain('Usage: qtiauth audit verify');
  });
});
