import { configCheck } from './commands/config-check.ts';
import { type CliIo, EXIT_OK, EXIT_USAGE } from './io.ts';

type Command = (args: readonly string[], io: CliIo) => Promise<number>;

const commands: Record<string, Command> = {
  'config check': configCheck,
};

const usage = `Usage: qtiauth <command> [options]

Commands:
${Object.keys(commands)
  .map((name) => `  ${name}`)
  .join('\n')}

Run qtiauth <command> --help for a command's options.
`;

export async function run(argv: readonly string[], io: CliIo): Promise<number> {
  const [first, second, ...rest] = argv;
  if (first === undefined || first === '--help' || first === '-h') {
    (first === undefined ? io.stderr : io.stdout)(usage);
    return first === undefined ? EXIT_USAGE : EXIT_OK;
  }

  const command = commands[`${first} ${second ?? ''}`];
  if (!command) {
    io.stderr(`Unknown command: ${[first, second].filter(Boolean).join(' ')}\n\n${usage}`);
    return EXIT_USAGE;
  }
  return command(rest, io);
}
