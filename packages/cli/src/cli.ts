import { configCheck } from './commands/config-check.ts';
import { dbProvision } from './commands/db-provision.ts';
import { listsAudit } from './commands/lists-audit.ts';
import { listsUpdate } from './commands/lists-update.ts';
import { type CliIo, type Command, CommandExit, EXIT_OK, EXIT_USAGE } from './io.ts';

export const commands: Record<string, Command> = {
  'config check': configCheck,
  'db provision': dbProvision,
  'lists update': listsUpdate,
  'lists audit': listsAudit,
};

function usage(available: Record<string, Command>): string {
  return `Usage: qtiauth <command> [options]

Commands:
${Object.keys(available)
  .map((name) => `  ${name}`)
  .join('\n')}

Run qtiauth <command> --help for a command's options.
`;
}

export async function run(
  argv: readonly string[],
  io: CliIo,
  available: Record<string, Command> = commands,
): Promise<number> {
  const [first, second, ...rest] = argv;
  if (first === undefined || first === '--help' || first === '-h') {
    (first === undefined ? io.stderr : io.stdout)(usage(available));
    return first === undefined ? EXIT_USAGE : EXIT_OK;
  }

  const command = available[`${first} ${second ?? ''}`];
  if (!command) {
    io.stderr(
      `Unknown command: ${[first, second].filter(Boolean).join(' ')}\n\n${usage(available)}`,
    );
    return EXIT_USAGE;
  }

  try {
    return await command(rest, io);
  } catch (error) {
    if (!(error instanceof CommandExit)) throw error;
    io.stderr(`${error.message.trimEnd()}\n`);
    return error.exitCode;
  }
}
