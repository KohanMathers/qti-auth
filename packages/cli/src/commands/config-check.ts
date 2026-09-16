import { readFile } from 'node:fs/promises';
import { parseArgs, parseEnv } from 'node:util';

import {
  CONFIG_PATH_ENV,
  ConfigError,
  DEFAULT_CONFIG_PATH,
  loadConfig,
  qtiauthConfigSchema,
  resolveConfigPath,
} from '@qtiauth/config';

import { type CliIo, EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from '../io.ts';

export const usage = `Usage: qtiauth config check [--config <path>] [--env-file <path>]

Validates qtiauth.yaml, including every \${env:…} and \${file:…} reference, without starting anything. Exits 0 if the config is valid and 1 if it isn't.

Options:
  -c, --config <path>  Config file (default: $${CONFIG_PATH_ENV}, then ${DEFAULT_CONFIG_PATH})
  --env-file <path>    Read environment variables from a .env file. Variables already set in the environment take precedence.
  -h, --help           Show this help
`;

export async function configCheck(args: readonly string[], io: CliIo): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...args],
      options: {
        config: { type: 'string', short: 'c' },
        'env-file': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (error) {
    io.stderr(`${(error as Error).message}\n\n${usage}`);
    return EXIT_USAGE;
  }

  if (values.help) {
    io.stdout(usage);
    return EXIT_OK;
  }

  let env = io.env;
  const envFile = values['env-file'];
  if (envFile !== undefined) {
    try {
      env = { ...parseEnv(await readFile(envFile, 'utf8')), ...io.env };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? 'read failed';
      io.stderr(`Can't read env file ${envFile} (${code})\n`);
      return EXIT_FAILURE;
    }
  }

  const path = values.config ?? resolveConfigPath(env);
  try {
    await loadConfig(qtiauthConfigSchema, { path, env });
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    io.stderr(`${error.message}\n`);
    return EXIT_FAILURE;
  }

  io.stdout(`${path} is valid.\n`);
  return EXIT_OK;
}
