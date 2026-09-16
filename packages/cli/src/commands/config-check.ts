import { qtiauthConfigSchema } from '@qtiauth/config';

import { type CliIo, EXIT_OK } from '../io.ts';
import { configOptionsUsage, loadCommandConfig, parseConfigArgs } from '../options.ts';

export const usage = `Usage: qtiauth config check [--config <path>] [--env-file <path>]

Validates qtiauth.yaml, including every \${env:…} and \${file:…} reference, without starting anything. Exits 0 if the config is valid and 1 if it isn't.

Options:
${configOptionsUsage}
`;

export async function configCheck(args: readonly string[], io: CliIo): Promise<number> {
  const values = parseConfigArgs(args, usage);
  if (values.help) {
    io.stdout(usage);
    return EXIT_OK;
  }

  const { path } = await loadCommandConfig(qtiauthConfigSchema, values, io);
  io.stdout(`${path} is valid.\n`);
  return EXIT_OK;
}
