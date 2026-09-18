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

import { issueAdminSignup } from './admin.ts';
import type { Database } from './database.ts';
import { emailNormalizer } from './email.ts';
import { definition } from './service.ts';
import { magicLinkUrl } from './settings.ts';

export const adminCreateUsage = `Usage: qtiauth admin create --email <address> [--config <path>] [--env-file <path>]

Issues a one-time signup link that grants the admin role. Refuses if an admin already exists. There are no default credentials.

Options:
  --email <address>   Address the first admin will sign up with
${configOptionsUsage}
`;

export const adminCreate: Command = async (args, io) => {
  let values: { email?: string; config?: string; 'env-file'?: string; help?: boolean };
  try {
    values = parseArgs({
      args: [...args],
      options: {
        email: { type: 'string' },
        config: { type: 'string', short: 'c' },
        'env-file': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    }).values;
  } catch (error) {
    throw new CommandExit(EXIT_USAGE, `${(error as Error).message}\n\n${adminCreateUsage}`);
  }
  if (values.help) {
    io.stdout(adminCreateUsage);
    return EXIT_OK;
  }
  if (values.email === undefined || values.email.trim() === '') {
    throw new CommandExit(EXIT_USAGE, `--email is required\n\n${adminCreateUsage}`);
  }

  const loaded = await loadCommandConfig(serviceSchema(definition), values, io);
  const db = createDb<Database>(loaded.config.database, definition.database.schema);
  try {
    const result = await issueAdminSignup(db, {
      email: values.email.trim(),
      locale: loaded.config.email.default_locale,
      ttl: loaded.config.magic_link.ttl,
      normalizeEmail: emailNormalizer(loaded.config.accounts.email_normalization),
      roles: loaded.config.roles,
      now: new Date(),
    });
    if (result.status === 'admin_exists') {
      throw new CommandExit(EXIT_FAILURE, 'An admin already exists');
    }
    io.stdout(`${magicLinkUrl(loaded.config, result.token)}\n`);
    return EXIT_OK;
  } finally {
    await db.destroy();
  }
};
