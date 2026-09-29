import { CommandExit, EXIT_FAILURE } from '@qtiauth/cli';

export interface Flags {
  help?: boolean;
  config?: string;
  'env-file'?: string;
  [key: string]: boolean | string | undefined;
}

export interface SplitArgs {
  archiveId: string | undefined;
  flags: Flags;
}

export interface SplitArgsOptions {
  usage: string;
  // Extra boolean flags this command accepts (long form without the leading `--`).
  booleanFlags?: readonly string[];
}

export function splitArgs(args: readonly string[], options: SplitArgsOptions): SplitArgs {
  const { usage } = options;
  const booleanFlags = new Set(options.booleanFlags ?? []);
  const flags: Flags = {};
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? '';
    if (arg === '--help' || arg === '-h') {
      flags.help = true;
    } else if (arg === '--config' || arg === '-c') {
      const next = args[++i];
      if (next === undefined) {
        throw new CommandExit(EXIT_FAILURE, `Missing value for ${arg}\n\n${usage}`);
      }
      flags.config = next;
    } else if (arg.startsWith('--config=')) {
      flags.config = arg.slice('--config='.length);
    } else if (arg === '--env-file') {
      const next = args[++i];
      if (next === undefined) {
        throw new CommandExit(EXIT_FAILURE, `Missing value for ${arg}\n\n${usage}`);
      }
      flags['env-file'] = next;
    } else if (arg.startsWith('--env-file=')) {
      flags['env-file'] = arg.slice('--env-file='.length);
    } else if (arg.startsWith('--') && booleanFlags.has(arg.slice(2))) {
      flags[arg.slice(2)] = true;
    } else if (arg.startsWith('-')) {
      throw new CommandExit(EXIT_FAILURE, `Unknown option: ${arg}\n\n${usage}`);
    } else {
      positionals.push(arg);
    }
  }
  return { archiveId: positionals[0], flags };
}
