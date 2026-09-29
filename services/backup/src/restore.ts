import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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
import { decodeJson, storageManifestSchema } from './manifest.ts';
import { runPgRestore, runPsql } from './pg-cli.ts';
import { openArchive } from './reader.ts';
import { type Context, definition } from './service.ts';
import { backupEncryptionKey } from './settings.ts';
import { attachStorage } from './start.ts';

export const backupRestoreUsage = `Usage: qtiauth backup restore <archive-id> [--config <path>] [--env-file <path>] [--skip-ledger-replay]

Puts the stack into maintenance mode (stop every service but the gateway before running this), drops each service schema, restores from the backup, replays the deletion ledger over the restored data, and revokes every restored session and binding. Migrations run again the next time each service starts.

Options:
  --skip-ledger-replay  Skip the deletion-ledger replay. Only use when the ledger is unavailable.
${configOptionsUsage}
`;

type BackupConfig = Context['config'];

export const backupRestore: Command = async (args, io) => {
  const parsed = splitArgs(args, {
    usage: backupRestoreUsage,
    booleanFlags: ['skip-ledger-replay'],
  });
  if (parsed.flags.help) {
    io.stdout(backupRestoreUsage);
    return EXIT_OK;
  }
  if (parsed.archiveId === undefined) {
    throw new CommandExit(EXIT_FAILURE, `Missing <archive-id>\n\n${backupRestoreUsage}`);
  }
  const skipLedger = parsed.flags['skip-ledger-replay'] === true;

  const loaded = await loadCommandConfig(serviceSchema(definition), parsed.flags, io);
  const config = loaded.config as BackupConfig;
  if (config.backups.admin_password === '') {
    throw new CommandExit(EXIT_FAILURE, 'backups.admin_password is empty');
  }
  const key = backupEncryptionKey(config);
  const store = attachStorage(config);
  const destination = backupDestination(config.backups, config.storage, store);
  try {
    const bytes = await readBackup(destination, parsed.archiveId);
    const opened = openArchive(bytes, key);
    io.stdout(`Restoring backup ${opened.manifest.archive_id}\n`);

    const tempDir = await mkdtemp(join(tmpdir(), 'qtiauth-restore-'));
    try {
      for (const entry of opened.manifest.schemas) {
        await runPsql(config, config.database.name, [
          '-c',
          `drop schema if exists "${entry.schema}" cascade`,
        ]);
        const dumpPath = join(tempDir, `${entry.schema}.dump`);
        await writeFile(dumpPath, opened.readBlob(entry.path));
        await runPgRestore(config, config.database.name, dumpPath, entry.schema);
        io.stdout(`  ${entry.schema} restored\n`);
      }

      if (!skipLedger) {
        const userIds = await collectLedgerUserIds(config);
        if (userIds.length > 0) {
          await runSqlBatch(config, buildLedgerReplaySql(userIds));
        }
        io.stdout(`Deletion ledger replayed: ${String(userIds.length)} user(s) re-erased\n`);
      }

      await runSqlBatch(config, [
        `update identity.sessions set revoked_at = now(), revoke_reason = 'backup_restore' where revoked_at is null`,
        `delete from identity.session_bindings`,
      ]);
      io.stdout('Sessions and bindings revoked.\n');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
    io.stdout(`Backup ${opened.manifest.archive_id} restored.\n`);
    return EXIT_OK;
  } finally {
    if (store) await store.close();
  }
};

async function collectLedgerUserIds(config: BackupConfig): Promise<string[]> {
  const store = attachStorage(config);
  const dir = join(config.backups.directory, 'deletion-ledger');
  const userIds: string[] = [];
  try {
    if (store) {
      const objects = await store.list('deletion-ledger/');
      for (const object of objects) {
        const body = await store.get(object.key);
        if (body) userIds.push(parseUserId(Buffer.from(body)));
      }
      return userIds;
    }
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return userIds;
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      userIds.push(parseUserId(await readFile(join(dir, name))));
    }
    return userIds;
  } finally {
    if (store) await store.close();
  }
}

function parseUserId(body: Buffer): string {
  const value = decodeJson(body) as { user_id?: unknown };
  if (typeof value.user_id !== 'string' || value.user_id === '') {
    throw new CommandExit(EXIT_FAILURE, 'Deletion ledger entry is missing user_id');
  }
  return value.user_id;
}

function buildLedgerReplaySql(userIds: readonly string[]): string[] {
  const values = userIds.map(quoteLiteral).join(',');
  return [
    `delete from identity.users where id in (${values})`,
    `delete from identity.sessions where user_id in (${values})`,
    `delete from identity.session_bindings where session_id in (select id from identity.sessions where user_id in (${values}))`,
  ];
}

function quoteLiteral(value: string): string {
  if (!/^[0-9A-Za-z-]+$/.test(value)) {
    throw new CommandExit(EXIT_FAILURE, `Invalid user id in deletion ledger: ${value}`);
  }
  return `'${value}'`;
}

async function runSqlBatch(config: BackupConfig, statements: readonly string[]): Promise<void> {
  const body = statements.map((statement) => `${statement};`).join('\n');
  const tempDir = await mkdtemp(join(tmpdir(), 'qtiauth-restore-sql-'));
  try {
    const file = join(tempDir, 'batch.sql');
    await writeFile(file, body);
    await runPsql(config, config.database.name, ['--file', file]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export function readStorageManifest(bytes: Buffer) {
  return storageManifestSchema.parse(decodeJson(bytes));
}
