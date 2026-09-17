import { dirname } from 'node:path';

import {
  CommandExit,
  configCommand,
  configOptionsUsage,
  EXIT_FAILURE,
  EXIT_OK,
} from '@qtiauth/cli';
import { serviceSchema } from '@qtiauth/service-kit';

import { definition } from './service.ts';
import { loadConfiguredTemplates } from './start.ts';
import { TemplateError } from './templates.ts';

export const templatesCheckUsage = `Usage: qtiauth templates check [--config <path>] [--env-file <path>]

Checks every email template the notifier would use: the built-in templates plus overrides in email.templates_dir, next to the config file. Fails on a missing file, a variable a template can't use or invalid MJML, which would also stop the notifier from starting. Prints each template and the locales it has.

Options:
${configOptionsUsage}
`;

export function templatesCheckCommand(defaultTemplatesDir?: string) {
  return configCommand({
    usage: templatesCheckUsage,
    schema: serviceSchema(definition),
    run: async ({ io, config, path }) => {
      try {
        const templates = await loadConfiguredTemplates(config, dirname(path), defaultTemplatesDir);
        io.stdout(
          `${JSON.stringify({ default_locale: templates.defaultLocale, templates: templates.templates }, null, 2)}\n`,
        );
        return EXIT_OK;
      } catch (error) {
        if (!(error instanceof TemplateError)) throw error;
        throw new CommandExit(EXIT_FAILURE, error.message);
      }
    },
  });
}

export const templatesCheck = templatesCheckCommand();
