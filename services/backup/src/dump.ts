import { spawn } from 'node:child_process';

import type { QtiauthConfig } from '@qtiauth/config';

export class PgDumpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PgDumpError';
  }
}

export interface DumpSpec {
  binary: string;
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  schema: string;
  timeoutMs: number;
  ssl: QtiauthConfig['database']['ssl'];
}

export interface DumpOutput {
  onChunk: (chunk: Buffer) => Promise<void>;
}

export async function pgDumpSchema(spec: DumpSpec, output: DumpOutput): Promise<number> {
  const args = [
    '--format=custom',
    '--no-owner',
    '--no-privileges',
    '--serializable-deferrable',
    `--schema=${spec.schema}`,
    `--host=${spec.host}`,
    `--port=${String(spec.port)}`,
    `--username=${spec.user}`,
    `--dbname=${spec.database}`,
  ];
  return runProcess(
    spec.binary,
    args,
    output,
    {
      PGPASSWORD: spec.password,
      PGSSLMODE: pgSslMode(spec.ssl),
      PGCONNECT_TIMEOUT: '10',
    },
    spec.timeoutMs,
  );
}

export async function pgDumpVersion(binary: string): Promise<string> {
  const chunks: Buffer[] = [];
  await runProcess(
    binary,
    ['--version'],
    {
      onChunk: (chunk) => {
        chunks.push(chunk);
        return Promise.resolve();
      },
    },
    {},
    10_000,
  );
  return Buffer.concat(chunks).toString('utf8').trim();
}

export function pgSslMode(ssl: QtiauthConfig['database']['ssl']): string {
  if (ssl === 'disable') return 'disable';
  if (ssl === 'require') return 'require';
  return 'verify-full';
}

function runProcess(
  binary: string,
  args: string[],
  output: DumpOutput,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stderr: Buffer[] = [];
    let queue: Promise<void> = Promise.resolve();
    let bytes = 0;
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
      reject(new PgDumpError(`${binary} timed out after ${String(timeoutMs)}ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      child.stdout.pause();
      queue = queue
        .then(() => output.onChunk(chunk))
        .then(() => {
          child.stdout.resume();
        })
        .catch((error: unknown) => {
          killed = true;
          child.kill('SIGKILL');
          reject(error instanceof Error ? error : new PgDumpError(String(error)));
        });
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr.push(chunk);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new PgDumpError(`${binary} failed to start: ${error.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const swallow = (): void => undefined;
      queue
        .then(() => {
          if (killed) return;
          if (code === 0) {
            resolve(bytes);
            return;
          }
          const message = Buffer.concat(stderr).toString('utf8').trim();
          reject(
            new PgDumpError(
              `${binary} exited with code ${String(code ?? -1)}${message ? `: ${message}` : ''}`,
            ),
          );
        })
        .catch(swallow);
    });
  });
}
