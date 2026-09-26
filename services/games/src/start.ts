import { consumeCron, pruneBusTables } from '@qtiauth/bus';
import { type StartServiceOptions, type Stoppable, unwind } from '@qtiauth/service-kit';

import type { Database } from './database.ts';
import {
  eraseUserEntitlements,
  expireEntitlements,
  exportUserEntitlements,
} from './entitlements.ts';
import { gamesMetrics } from './metrics.ts';
import { type Context, type definition, router } from './service.ts';

export const RETENTION_JOB = 'retention.sweep';
export const EXPIRE_ENTITLEMENTS_JOB = 'games.expire_entitlements';

export function gamesService() {
  return {
    router,
    dataRights: ({ db }) => ({
      exportUser: async (userId) => ({
        entitlements: await exportUserEntitlements(db, userId),
      }),
      eraseUser: async (userId, trx) => {
        await eraseUserEntitlements(trx, userId);
      },
    }),
    start: async (ctx: Context) => {
      const { bus, db, log } = ctx;
      const metrics = gamesMetrics(ctx.metrics);
      const stack: Stoppable[] = [];
      try {
        stack.push(
          await consumeCron(bus, {
            job: EXPIRE_ENTITLEMENTS_JOB,
            metrics: ctx.busMetrics,
            handler: async () => {
              const sources = await expireEntitlements(db, new Date());
              for (const source of sources) metrics.revoked(source);
              if (sources.length > 0) {
                log.info('entitlements expired', { count: sources.length });
                ctx.outbox.wake();
              }
            },
            onError: (error) => {
              log.error('entitlement expiry sweep failed', { error });
            },
          }),
        );

        stack.push(
          await consumeCron(bus, {
            job: RETENTION_JOB,
            metrics: ctx.busMetrics,
            handler: async () => {
              const pruned = await pruneBusTables(db, ctx.config.bus);
              if (pruned.outbox > 0 || pruned.processedEvents > 0) {
                log.info('retention sweep finished', {
                  outbox: pruned.outbox,
                  processed_events: pruned.processedEvents,
                });
              }
            },
            onError: (error) => {
              log.error('retention sweep failed', { error });
            },
          }),
        );

        log.info('games started');
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
