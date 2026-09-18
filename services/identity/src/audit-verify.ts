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
import { createAuditDb } from '@qtiauth/db';
import { serviceSchema } from '@qtiauth/service-kit';

import { verifyAuditLog } from './audit.ts';
import type { Database } from './database.ts';
import { definition } from './service.ts';

export const auditVerifyUsage = `Usage: qtiauth audit verify [--config <path>] [--env-file <path>]

Checks the audit log hash chain. Exits 0 if every row matches, or 1 and names the first row that does not.

Options:
${configOptionsUsage}
`;

export const auditVerify: Command = async (args, io) => {
  let values: { config?: string; 'env-file'?: string; help?: boolean };
  try {
    values = parseArgs({
      args: [...args],
      options: {
        config: { type: 'string', short: 'c' },
        'env-file': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    }).values;
  } catch (error) {
    throw new CommandExit(EXIT_USAGE, `${(error as Error).message}\n\n${auditVerifyUsage}`);
  }
  if (values.help) {
    io.stdout(auditVerifyUsage);
    return EXIT_OK;
  }

  const loaded = await loadCommandConfig(serviceSchema(definition), values, io);
  const db = createAuditDb<Database>(loaded.config.database);
  try {
    const result = await verifyAuditLog(db);
    if (result.ok) {
      io.stdout(`Audit log is intact (${String(result.count)} records).\n`);
      return EXIT_OK;
    }
    throw new CommandExit(
      EXIT_FAILURE,
      `Audit log row seq=${String(result.seq)} event_id=${result.event_id} does not match the hash chain`,
    );
  } finally {
    await db.destroy();
  }
};
