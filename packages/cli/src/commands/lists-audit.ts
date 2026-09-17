import { auditLists, loadWordLists, resolveListsDir } from '@qtiauth/text-filter';

import { configCommand } from '../command.ts';
import { EXIT_OK } from '../io.ts';
import { configOptionsUsage } from '../options.ts';
import { listsCommandSchema } from './lists-shared.ts';

export const listsAuditUsage = `Usage: qtiauth lists audit [--config <path>] [--env-file <path>]

Prints every dictionary, name or place word that contains a blocked substring. Run this after lists update so missing places and surnames can be added to the dictionary before they cause false positives.

Options:
${configOptionsUsage}
`;

export const listsAudit = configCommand({
  usage: listsAuditUsage,
  schema: listsCommandSchema,
  run: async ({ io, path, config }) => {
    const lists = await loadWordLists(resolveListsDir(path, config.text_filter.lists_dir));
    const hits = auditLists(lists);
    if (hits.length === 0) {
      io.stdout('No dictionary words contain a blocked substring.\n');
      return EXIT_OK;
    }
    io.stdout(`${hits.map((hit) => `${hit.word}\t${hit.matched}`).join('\n')}\n`);
    return EXIT_OK;
  },
});
