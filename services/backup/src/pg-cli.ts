import { spawn } from 'node:child_process';

import { CommandExit, EXIT_FAILURE } from '@qtiauth/cli';

import { pgSslMode } from './dump.ts';
import type { Context } from './service.ts';

type BackupConfig = Context['config'];

export async function runPsql(
  config: BackupConfig,
  database: string,
  extra: string[],
): Promise<void> {
  await runBinary(
    config.backups.psql,
    [
      `--host=${config.database.host}`,
      `--port=${String(config.database.port)}`,
      `--username=${config.backups.admin_user}`,
      '--no-psqlrc',
      '--set=ON_ERROR_STOP=1',
      `--dbname=${database}`,
      ...extra,
    ],
    {
      PGPASSWORD: config.backups.admin_password,
      PGSSLMODE: pgSslMode(config.database.ssl),
    },
  );
}

export async function runPgRestore(
  config: BackupConfig,
  database: string,
  path: string,
  schema: string,
): Promise<void> {
  await runBinary(
    config.backups.pg_restore,
    [
      `--host=${config.database.host}`,
      `--port=${String(config.database.port)}`,
      `--username=${config.backups.admin_user}`,
      `--dbname=${database}`,
      '--no-owner',
      '--no-privileges',
      '--exit-on-error',
      '--single-transaction',
      `--schema=${schema}`,
      path,
    ],
    {
      PGPASSWORD: config.backups.admin_password,
      PGSSLMODE: pgSslMode(config.database.ssl),
    },
  );
}

function runBinary(binary: string, args: string[], env: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'inherit', 'pipe'],
    });
    const stderr: Buffer[] = [];
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const message = Buffer.concat(stderr).toString('utf8').trim();
      reject(
        new CommandExit(
          EXIT_FAILURE,
          `${binary} exited with code ${String(code ?? -1)}${message ? `: ${message}` : ''}`,
        ),
      );
    });
  });
}
