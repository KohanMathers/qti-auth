import { parseArgs } from 'node:util';

import {
  type Command,
  CommandExit,
  configOptionsUsage,
  EXIT_FAILURE,
  EXIT_OK,
  EXIT_USAGE,
  loadCommandConfig,
} from '@qtiauth/cli';
import { createDb } from '@qtiauth/db';
import { serviceSchema } from '@qtiauth/service-kit';

import { exportUser } from './data-rights.ts';
import type { Database } from './database.ts';
import { requestDeletion } from './lifecycle.ts';
import { definition } from './service.ts';

export const userExportUsage = `Usage: qtiauth user export <user-id> [--config <path>] [--env-file <path>]

Prints this account’s identity-service data as JSON.

Options:
${configOptionsUsage}
`;

export const userDeleteUsage = `Usage: qtiauth user delete <user-id> [--config <path>] [--env-file <path>]

Schedules the account for deletion after accounts.deletion_grace. Signing in during that time cancels it.

Options:
${configOptionsUsage}
`;

function parseUserCommand(
  args: readonly string[],
  usage: string,
): { userId: string; config?: string; 'env-file'?: string; help?: boolean } {
  let parsed: {
    values: { config?: string; 'env-file'?: string; help?: boolean };
    positionals: string[];
  };
  try {
    parsed = parseArgs({
      args: [...args],
      options: {
        config: { type: 'string', short: 'c' },
        'env-file': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: true,
    });
  } catch (error) {
    throw new CommandExit(EXIT_USAGE, `${(error as Error).message}\n\n${usage}`);
  }
  if (parsed.values.help) return { userId: '', help: true };
  const userId = parsed.positionals[0];
  if (userId === undefined || parsed.positionals.length > 1) {
    throw new CommandExit(EXIT_USAGE, `A user id is required\n\n${usage}`);
  }
  return { userId, ...parsed.values };
}

export const userExport: Command = async (args, io) => {
  const values = parseUserCommand(args, userExportUsage);
  if (values.help) {
    io.stdout(userExportUsage);
    return EXIT_OK;
  }

  const loaded = await loadCommandConfig(serviceSchema(definition), values, io);
  const db = createDb<Database>(loaded.config.database, definition.database.schema);
  try {
    const data = await exportUser(db, values.userId);
    if (Object.keys(data).length === 0) {
      throw new CommandExit(EXIT_FAILURE, 'No such account');
    }
    io.stdout(`${JSON.stringify(data, null, 2)}\n`);
    return EXIT_OK;
  } finally {
    await db.destroy();
  }
};

export const userDelete: Command = async (args, io) => {
  const values = parseUserCommand(args, userDeleteUsage);
  if (values.help) {
    io.stdout(userDeleteUsage);
    return EXIT_OK;
  }

  const loaded = await loadCommandConfig(serviceSchema(definition), values, io);
  const db = createDb<Database>(loaded.config.database, definition.database.schema);
  try {
    const result = await requestDeletion(db, {
      userId: values.userId,
      actor: { type: 'system', id: 'cli' },
      now: new Date(),
    });
    if (result.status === 'not_found') throw new CommandExit(EXIT_FAILURE, 'No such account');
    if (result.status === 'conflict') {
      throw new CommandExit(EXIT_FAILURE, 'The account is not in a state that allows deletion');
    }
    io.stdout(`Deletion scheduled for ${values.userId}\n`);
    return EXIT_OK;
  } finally {
    await db.destroy();
  }
};
