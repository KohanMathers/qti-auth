import { parseArgs } from 'node:util';

import { ListUpdateError, resolveListsDir, updateLists } from '@qtiauth/text-filter';

import { type Command, CommandExit, EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from '../io.ts';
import { type ConfigArgs, configOptionsUsage, loadCommandConfig } from '../options.ts';
import { listsCommandSchema } from './lists-shared.ts';

export const listsUpdateUsage = `Usage: qtiauth lists update [--ldnoobw <commit>] [--config <path>] [--env-file <path>]

Downloads the pinned word lists into text_filter.lists_dir (next to the config file): every LDNOOBW language file at the given commit except Klingon, SCOWL size 70, ONS and US SSA given names, US Census surnames, and GeoNames places. Spaces are stripped from multi-word LDNOOBW entries. Does not replace allow.txt or extra-block.txt if they already exist.

Options:
  --ldnoobw <commit>   LDNOOBW git commit to vendor (default: the commit shipped with this release)
${configOptionsUsage}
`;

export const listsUpdate: Command = async (args, io) => {
  let values: ConfigArgs & { ldnoobw?: string };
  try {
    values = parseArgs({
      args: [...args],
      options: {
        config: { type: 'string', short: 'c' },
        'env-file': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        ldnoobw: { type: 'string' },
      },
    }).values;
  } catch (error) {
    throw new CommandExit(EXIT_USAGE, `${(error as Error).message}\n\n${listsUpdateUsage}`);
  }
  if (values.help) {
    io.stdout(listsUpdateUsage);
    return EXIT_OK;
  }

  const loaded = await loadCommandConfig(listsCommandSchema, values, io);
  const dir = resolveListsDir(loaded.path, loaded.config.text_filter.lists_dir);
  try {
    const result = await updateLists({
      dir,
      ...(values.ldnoobw === undefined ? {} : { ldnoobwCommit: values.ldnoobw }),
    });
    io.stdout(
      `Updated ${dir} from LDNOOBW ${result.ldnoobwCommit}: ${String(result.counts.ldnoobw)} blocked, ${String(result.counts.dictionary)} dictionary, ${String(result.counts.names)} names, ${String(result.counts.surnames)} surnames, ${String(result.counts.places)} places.\n`,
    );
    return EXIT_OK;
  } catch (error) {
    if (error instanceof ListUpdateError) throw new CommandExit(EXIT_FAILURE, error.message);
    throw error;
  }
};
