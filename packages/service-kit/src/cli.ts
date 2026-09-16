import {
  type CliIo,
  type Command,
  commands as baseCommands,
  EXIT_OK,
  EXIT_USAGE,
  migrateCommands,
  run,
} from '@qtiauth/cli';

import { openApiDocument } from './openapi.ts';
import type { Router } from './routes.ts';
import type { ServiceDefinition } from './service.ts';

const manifestUsage = `Usage: qtiauth routes manifest

Prints the route manifest this service announces to the gateway: every route's method, path and policy, and the permissions the service defines.
`;

const openapiUsage = `Usage: qtiauth routes openapi

Prints this service's OpenAPI 3.1 document, including every error code each route can return.
`;

function printCommand(usage: string, render: () => unknown): Command {
  return (args, io) => {
    if (args.includes('--help') || args.includes('-h')) {
      io.stdout(usage);
      return Promise.resolve(EXIT_OK);
    }
    if (args.length > 0) {
      io.stderr(`Unexpected argument: ${args[0] ?? ''}\n\n${usage}`);
      return Promise.resolve(EXIT_USAGE);
    }
    io.stdout(`${JSON.stringify(render(), null, 2)}\n`);
    return Promise.resolve(EXIT_OK);
  };
}

export function serviceCommands<Ctx>(
  definition: ServiceDefinition,
  router: Router<Ctx>,
  extra: Record<string, Command> = {},
): Record<string, Command> {
  return {
    ...baseCommands,
    ...(definition.database ? migrateCommands(definition.database) : {}),
    'routes manifest': printCommand(manifestUsage, () => router.manifest()),
    'routes openapi': printCommand(openapiUsage, () => openApiDocument(router)),
    ...extra,
  };
}

export async function runServiceCli<Ctx>(
  definition: ServiceDefinition,
  router: Router<Ctx>,
  extra: Record<string, Command> = {},
  argv: readonly string[] = process.argv.slice(2),
  io: CliIo = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    env: process.env,
  },
): Promise<void> {
  process.exitCode = await run(argv, io, serviceCommands(definition, router, extra));
}
