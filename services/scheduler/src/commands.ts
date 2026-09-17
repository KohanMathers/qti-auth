import { configCommand, configOptionsUsage, EXIT_OK } from '@qtiauth/cli';
import { serviceSchema } from '@qtiauth/service-kit';

import { nextRuns } from './scheduler.ts';
import { definition } from './service.ts';

export const jobsListUsage = `Usage: qtiauth jobs list [--config <path>] [--env-file <path>]

Prints every scheduled job with its cron pattern, whether it's enabled and when it next ticks, in scheduler.timezone.

Options:
${configOptionsUsage}
`;

export function jobsListCommand(now: () => number = Date.now) {
  return configCommand({
    usage: jobsListUsage,
    schema: serviceSchema(definition),
    run: ({ io, config }) => {
      const { timezone, jobs } = config.scheduler;
      io.stdout(
        `${JSON.stringify({ timezone, jobs: nextRuns(jobs, timezone, new Date(now())) }, null, 2)}\n`,
      );
      return Promise.resolve(EXIT_OK);
    },
  });
}

export const jobsList = jobsListCommand();
