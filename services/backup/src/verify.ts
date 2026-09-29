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

import { splitArgs } from './cli-args.ts';
import { backupDestination, readBackup } from './destination.ts';
import { runPgRestore, runPsql } from './pg-cli.ts';
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
  const { archiveId, flags } = splitArgs(args, { usage: backupVerifyUsage });
  if (flags.help) {
    io.stdout(backupVerifyUsage);
    return EXIT_OK;
  }
  if (archiveId === undefined) {
    throw new CommandExit(EXIT_FAILURE, `Missing <archive-id>\n\n${backupVerifyUsage}`);
  }

  const loaded = await loadCommandConfig(serviceSchema(definition), flags, io);
  const config: BackupConfig = loaded.config;
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
