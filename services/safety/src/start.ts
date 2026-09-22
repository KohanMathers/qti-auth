import { consumeCron, pruneBusTables } from '@qtiauth/bus';
import { type StartServiceOptions, type Stoppable, unwind } from '@qtiauth/service-kit';

import type { Database } from './database.ts';
import { eraseUserReports, exportUserReports, sweepClosedReports } from './reports.ts';
import { type Context, type definition, router } from './service.ts';
import { sweepSlaBreaches } from './sla.ts';

export const SLA_SWEEP_JOB = 'safety.sla_sweep';
export const RETENTION_JOB = 'retention.sweep';

export function safetyService() {
  return {
    router,
    dataRights: ({ db }) => ({
      exportUser: async (userId) => ({
        reports: await exportUserReports(db, userId),
      }),
      eraseUser: async (userId, trx) => {
        await eraseUserReports(trx, userId);
      },
    }),
    start: async (ctx: Context) => {
      const { bus, db, log } = ctx;
      const stack: Stoppable[] = [];
      try {
        stack.push(
          await consumeCron(bus, {
            job: SLA_SWEEP_JOB,
            metrics: ctx.busMetrics,
            handler: async () => {
              const breaches = await sweepSlaBreaches(db, new Date());
              if (breaches.length > 0) {
                log.warn('safety report SLA breached', {
                  count: breaches.length,
                  reports: breaches.map((b) => ({
                    report_id: b.reportId,
                    type: b.type,
                    priority: b.priority,
                    overdue_by_seconds: b.overdueBySeconds,
                  })),
                });
                ctx.outbox.wake();
              }
            },
            onError: (error) => {
              log.error('sla sweep failed', { error });
            },
          }),
        );

        stack.push(
          await consumeCron(bus, {
            job: RETENTION_JOB,
            metrics: ctx.busMetrics,
            handler: async () => {
              const reports = await sweepClosedReports(db, {
                retention: ctx.config.retention.safety_reports,
                now: new Date(),
              });
              const pruned = await pruneBusTables(db, ctx.config.bus);
              log.info('retention sweep finished', {
                reports,
                outbox: pruned.outbox,
                processed_events: pruned.processedEvents,
              });
            },
            onError: (error) => {
              log.error('retention sweep failed', { error });
            },
          }),
        );

        log.info('safety started', {
          taxonomy_types: Object.keys(ctx.config.safety.taxonomy.types).length,
          intake: ctx.config.features.safety.game_intake.enabled,
          automated_flags: ctx.config.features.safety.automated_flags.enabled,
        });
        return stack;
      } catch (error) {
        await unwind(stack.splice(0).map((task) => () => task.stop())).catch(
          (cleanupError: unknown) => {
            log.error('cleanup after failed start also failed', { error: cleanupError });
          },
        );
        throw error;
      }
    },
  } satisfies StartServiceOptions<typeof definition, Database>;
}
