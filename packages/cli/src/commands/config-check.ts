import { qtiauthConfigSchema } from '@qtiauth/config';

import { configCommand } from '../command.ts';
import { EXIT_OK } from '../io.ts';
import { configOptionsUsage } from '../options.ts';

export const usage = `Usage: qtiauth config check [--config <path>] [--env-file <path>]

Validates qtiauth.yaml, including every \${env:…} and \${file:…} reference, without starting anything. Exits 0 if the config is valid and 1 if it isn't.

Options:
${configOptionsUsage}
`;

export const configCheck = configCommand({
  usage,
  schema: qtiauthConfigSchema,
  run: ({ io, path }) => {
    io.stdout(`${path} is valid.\n`);
    return Promise.resolve(EXIT_OK);
  },
});
