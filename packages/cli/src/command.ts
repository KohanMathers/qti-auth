import type * as z from 'zod';

import { type CliIo, type Command, EXIT_OK } from './io.ts';
import { type ConfigArgs, loadCommandConfig, parseConfigArgs } from './options.ts';

export interface ConfigCommandInput<S extends z.ZodType> {
  args: ConfigArgs;
  io: CliIo;
  path: string;
  env: CliIo['env'];
  config: z.output<S>;
}

export interface ConfigCommandOptions<S extends z.ZodType> {
  usage: string;
  schema: S;
  run: (input: ConfigCommandInput<S>) => Promise<number>;
}

export function configCommand<S extends z.ZodType>(options: ConfigCommandOptions<S>): Command {
  return async (args, io) => {
    const values = parseConfigArgs(args, options.usage);
    if (values.help) {
      io.stdout(options.usage);
      return EXIT_OK;
    }
    const loaded = await loadCommandConfig(options.schema, values, io);
    return options.run({ args: values, io, ...loaded });
  };
}
