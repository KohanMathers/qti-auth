import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { run } from './cli.ts';
import type { CliIo } from './io.ts';

function capture(env: CliIo['env'] = {}) {
  const out = { stdout: '', stderr: '' };
  const io: CliIo = {
    stdout: (text) => (out.stdout += text),
    stderr: (text) => (out.stderr += text),
    env,
  };
  return { io, out };
}

let dir: string;
let valid: string;
let invalid: string;
let needsEnv: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'qtiauth-cli-'));
  valid = join(dir, 'valid.yaml');
  invalid = join(dir, 'invalid.yaml');
  needsEnv = join(dir, 'needs-env.yaml');
  await writeFile(valid, 'migrations:\n  auto_apply: false\n');
  await writeFile(invalid, 'cookies:\n  session_ttl: forever\n');
  await writeFile(needsEnv, 'branding:\n  company_name: ${env:COMPANY}\n');
  await writeFile(join(dir, '.env'), 'COMPANY=From File\n');
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('qtiauth', () => {
  it('prints usage and exits 2 without a command', async () => {
    const { io, out } = capture();
    expect(await run([], io)).toBe(2);
    expect(out.stderr).toContain('config check');
  });

  it('rejects unknown commands', async () => {
    const { io, out } = capture();
    expect(await run(['config', 'nope'], io)).toBe(2);
    expect(out.stderr).toContain('Unknown command: config nope');
  });
});

describe('qtiauth config check', () => {
  it('exits 0 for valid config', async () => {
    const { io, out } = capture();
    expect(await run(['config', 'check', '--config', valid], io)).toBe(0);
    expect(out.stdout).toBe(`${valid} is valid.\n`);
  });

  it('exits 1 and names the YAML path for invalid config', async () => {
    const { io, out } = capture();
    expect(await run(['config', 'check', '-c', invalid], io)).toBe(1);
    expect(out.stderr).toContain(
      'cookies.session_ttl (line 2, column 16): Must be a duration like 30s, 15m, 12h or 7d',
    );
  });

  it('uses QTIAUTH_CONFIG when --config is not given', async () => {
    const { io } = capture({ QTIAUTH_CONFIG: invalid });
    expect(await run(['config', 'check'], io)).toBe(1);
  });

  it('reads variables from --env-file, with the environment taking precedence', async () => {
    const envFile = join(dir, '.env');

    const withoutFile = capture();
    expect(await run(['config', 'check', '-c', needsEnv], withoutFile.io)).toBe(1);
    expect(withoutFile.out.stderr).toContain('Environment variable COMPANY is not set');

    const withFile = capture();
    expect(await run(['config', 'check', '-c', needsEnv, '--env-file', envFile], withFile.io)).toBe(
      0,
    );

    const missingFile = capture();
    expect(
      await run(['config', 'check', '--env-file', join(dir, 'missing.env')], missingFile.io),
    ).toBe(1);
    expect(missingFile.out.stderr).toContain("Can't read env file");
  });

  it('exits 2 on unknown options', async () => {
    const { io, out } = capture();
    expect(await run(['config', 'check', '--nope'], io)).toBe(2);
    expect(out.stderr).toContain('Usage: qtiauth config check');
  });

  it('exits non-zero as a real process', async () => {
    const main = join(import.meta.dirname, 'main.ts');
    const error = await promisify(execFile)(process.execPath, [
      main,
      'config',
      'check',
      '-c',
      invalid,
    ]).then(
      () => undefined,
      (e: unknown) => e as { code: number; stderr: string },
    );
    expect(error?.code).toBe(1);
    expect(error?.stderr).toContain('cookies.session_ttl');
  });
});
