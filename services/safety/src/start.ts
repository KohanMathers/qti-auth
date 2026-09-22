import { consumeCron, pruneBusTables, RpcError, serveRpc } from '@qtiauth/bus';
import { type StartServiceOptions, type Stoppable, unwind } from '@qtiauth/service-kit';
import * as z from 'zod';

import { countOpenCases, encryptionKey, sweepCseaRetention } from './csea.ts';
import type { Database } from './database.ts';
import { safetyMetrics } from './metrics.ts';
import { USER_MODERATION_METHOD, userModeration } from './moderation.ts';
import {
  eraseUserReports,
  exportUserActions,
  exportUserAppeals,
  exportUserReports,
  sweepClosedReports,
} from './reports.ts';
import { type Context, type definition, router } from './service.ts';
import { sweepSlaBreaches } from './sla.ts';
import { objectStoreOf } from './storage.ts';

export const SLA_SWEEP_JOB = 'safety.sla_sweep';
export const RETENTION_JOB = 'retention.sweep';
export const CSEA_RETENTION_JOB = 'safety.csea_retention';

export function safetyService() {
  return {
    router,
    dataRights: ({ db }) => ({
      exportUser: async (userId) => ({
        reports: await exportUserReports(db, userId),
        actions: await exportUserActions(db, userId),
        appeals: await exportUserAppeals(db, userId),
      }),
      eraseUser: async (userId, trx) => {
        await eraseUserReports(trx, userId);
      },
    }),
    start: async (ctx: Context) => {
      const { bus, db, log } = ctx;
      if (ctx.config.features.safety.csea.enabled) {
        encryptionKey(ctx.config.safety.csea.encryption_key);
      }
      const store = objectStoreOf(ctx.config);
      const stack: Stoppable[] = [];
      try {
        if (store !== null) {
          if (ctx.config.storage.create_bucket) await store.ensureBucket();
          stack.push({ stop: () => store.close() });
        }

        stack.push(
          serveRpc(bus, {
            method: USER_MODERATION_METHOD,
            handler: async (request) => {
              const parsed = z.object({ user_id: z.uuid() }).safeParse(request);
              if (!parsed.success) throw new RpcError('bad_request', 'user_id is required');
              return userModeration(db, parsed.data.user_id);
            },
            onError: (error) => {
              log.error('user moderation lookup failed', { error });
            },
          }),
        );

        stack.push(
          await consumeCron(bus, {
            job: SLA_SWEEP_JOB,
            metrics: ctx.busMetrics,
            handler: async () => {
              const breaches = await sweepSlaBreaches(db, new Date());
              if (breaches.length > 0) {
                safetyMetrics(ctx.metrics).slaBreached();
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

        const runCseaRetention = async () => {
          const result = await sweepCseaRetention(db, { now: new Date(), store });
          safetyMetrics(ctx.metrics).cseaCasesOpen(await countOpenCases(db));
          if (result.evidence > 0 || result.references > 0) {
            log.info('csea retention sweep finished', {
              evidence: result.evidence,
              references: result.references,
            });
            ctx.outbox.wake();
          }
        };

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
              await runCseaRetention();
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

        stack.push(
          await consumeCron(bus, {
            job: CSEA_RETENTION_JOB,
            metrics: ctx.busMetrics,
            handler: runCseaRetention,
            onError: (error) => {
              log.error('csea retention sweep failed', { error });
            },
          }),
        );

        safetyMetrics(ctx.metrics).cseaCasesOpen(await countOpenCases(db));
        log.info('safety started', {
          taxonomy_types: Object.keys(ctx.config.safety.taxonomy.types).length,
          intake: ctx.config.features.safety.game_intake.enabled,
          automated_flags: ctx.config.features.safety.automated_flags.enabled,
          csea: ctx.config.features.safety.csea.enabled,
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
