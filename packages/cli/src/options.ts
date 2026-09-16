import { readFile } from 'node:fs/promises';
import { parseArgs, parseEnv } from 'node:util';

import {
  CONFIG_PATH_ENV,
  ConfigError,
  DEFAULT_CONFIG_PATH,
  loadConfig,
  resolveConfigPath,
} from '@qtiauth/config';
import type * as z from 'zod';

import { type CliIo, CommandExit, EXIT_FAILURE, EXIT_USAGE } from './io.ts';

export const configOptionsUsage = `  -c, --config <path>  Config file (default: $${CONFIG_PATH_ENV}, then ${DEFAULT_CONFIG_PATH})
  --env-file <path>    Read environment variables from a .env file. Variables already set in the environment take precedence.
  -h, --help           Show this help`;

export interface ConfigArgs {
  config?: string | undefined;
  'env-file'?: string | undefined;
  help?: boolean | undefined;
}

export function parseConfigArgs(args: readonly string[], usage: string): ConfigArgs {
  try {
    return parseArgs({
      args: [...args],
      options: {
        config: { type: 'string', short: 'c' },
        'env-file': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    }).values;
  } catch (error) {
    throw new CommandExit(EXIT_USAGE, `${(error as Error).message}\n\n${usage}`);
  }
}

export async function commandEnv(args: ConfigArgs, io: CliIo): Promise<CliIo['env']> {
  const envFile = args['env-file'];
  if (envFile === undefined) return io.env;
  try {
    return { ...parseEnv(await readFile(envFile, 'utf8')), ...io.env };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'read failed';
    throw new CommandExit(EXIT_FAILURE, `Can't read env file ${envFile} (${code})`);
  }
}

export async function loadCommandConfig<S extends z.ZodType>(
  schema: S,
  args: ConfigArgs,
  io: CliIo,
): Promise<{ path: string; env: CliIo['env']; config: z.output<S> }> {
  const env = await commandEnv(args, io);
  const path = args.config ?? resolveConfigPath(env);
  try {
    return { path, env, config: await loadConfig(schema, { path, env }) };
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    throw new CommandExit(EXIT_FAILURE, error.message);
  }
}
