import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type Command,
  CommandExit,
  configOptionsUsage,
  EXIT_FAILURE,
  EXIT_OK,
  loadCommandConfig,
} from '@qtiauth/cli';
import { serviceSchema } from '@qtiauth/service-kit';

import { backupDestination, readBackup } from './destination.ts';
import { pgSslMode } from './dump.ts';
import { openArchive } from './reader.ts';
import { type Context, definition } from './service.ts';
import { backupEncryptionKey } from './settings.ts';
import { attachStorage } from './start.ts';

export const backupVerifyUsage = `Usage: qtiauth backup verify <archive-id> [--config <path>] [--env-file <path>]

Reads a backup, decrypts and validates its manifest, then restores each schema into a scratch database (backups.scratch_database) and drops it. The live stack is not touched. Exits 0 when every schema restores, or 1 and names the schema that failed.

Options:
${configOptionsUsage}
`;

type BackupConfig = Context['config'];

export const backupVerify: Command = async (args, io) => {
  const { archiveId, flags } = splitArgs(args, backupVerifyUsage);
  if (flags.help) {
    io.stdout(backupVerifyUsage);
    return EXIT_OK;
  }
  if (archiveId === undefined) {
    throw new CommandExit(EXIT_FAILURE, `Missing <archive-id>\n\n${backupVerifyUsage}`);
  }

  const loaded = await loadCommandConfig(serviceSchema(definition), flags, io);
  const config = loaded.config as BackupConfig;
  if (config.backups.admin_password === '') {
    throw new CommandExit(EXIT_FAILURE, 'backups.admin_password is empty');
  }
  const key = backupEncryptionKey(config);
  const store = attachStorage(config);
  const destination = backupDestination(config.backups, config.storage, store);
  try {
    const bytes = await readBackup(destination, archiveId);
    const opened = openArchive(bytes, key);
    io.stdout(
      `Archive ${opened.manifest.archive_id} decrypts and holds ${String(opened.manifest.schemas.length)} schemas\n`,
    );

    const tempDir = await mkdtemp(join(tmpdir(), 'qtiauth-verify-'));
    try {
      const scratch = config.backups.scratch_database;
      await runPsql(config, 'postgres', ['-c', `drop database if exists "${scratch}"`]);
      await runPsql(config, 'postgres', ['-c', `create database "${scratch}"`]);
      try {
        for (const entry of opened.manifest.schemas) {
          const dump = opened.readBlob(entry.path);
          const dumpPath = join(tempDir, `${entry.schema}.dump`);
          await writeFile(dumpPath, dump);
          await runPgRestore(config, scratch, dumpPath, entry.schema);
          io.stdout(`  ${entry.schema} restored (${String(entry.plaintext_bytes)} bytes)\n`);
        }
      } finally {
        await runPsql(config, 'postgres', ['-c', `drop database "${scratch}"`]);
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
    io.stdout(`Backup ${archiveId} verified.\n`);
    return EXIT_OK;
  } finally {
    if (store) await store.close();
  }
};

interface Flags {
  help?: boolean;
  config?: string;
  'env-file'?: string;
}

interface SplitArgs {
  archiveId: string | undefined;
  flags: Flags;
}

export function splitArgs(args: readonly string[], usage: string): SplitArgs {
  const flags: Flags = {};
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? '';
    if (arg === '--help' || arg === '-h') {
      flags.help = true;
    } else if (arg === '--config' || arg === '-c') {
      const next = args[++i];
      if (next === undefined) {
        throw new CommandExit(EXIT_FAILURE, `Missing value for ${arg}\n\n${usage}`);
      }
      flags.config = next;
    } else if (arg.startsWith('--config=')) {
      flags.config = arg.slice('--config='.length);
    } else if (arg === '--env-file') {
      const next = args[++i];
      if (next === undefined) {
        throw new CommandExit(EXIT_FAILURE, `Missing value for ${arg}\n\n${usage}`);
      }
      flags['env-file'] = next;
    } else if (arg.startsWith('--env-file=')) {
      flags['env-file'] = arg.slice('--env-file='.length);
    } else if (arg === '--skip-ledger-replay') {
      continue;
    } else if (arg.startsWith('-')) {
      throw new CommandExit(EXIT_FAILURE, `Unknown option: ${arg}\n\n${usage}`);
    } else {
      positionals.push(arg);
    }
  }
  return { archiveId: positionals[0], flags };
}

async function runPsql(config: BackupConfig, database: string, extra: string[]): Promise<void> {
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

async function runPgRestore(
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
