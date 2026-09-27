import { consumeCron, pruneBusTables } from '@qtiauth/bus';
import { type StartServiceOptions, type Stoppable, unwind } from '@qtiauth/service-kit';

import { eraseUserAchievements, exportUserAchievements, recomputeRarity } from './achievements.ts';
import type { Database } from './database.ts';
import {
  eraseUserEntitlements,
  expireEntitlements,
  exportUserEntitlements,
} from './entitlements.ts';
import { eraseUserKeys, exportUserKeys, sweepRedeemAttempts } from './keys.ts';
import { gamesMetrics } from './metrics.ts';
import { type Context, type definition, router } from './service.ts';
import {
  closeStalePlaytimeSessions,
  eraseUserStats,
  exportUserCustomData,
  exportUserPlaytime,
  exportUserStats,
  resetDueLeaderboards,
} from './stats.ts';

const STALE_PLAYTIME_SECONDS = 300;

export const RETENTION_JOB = 'retention.sweep';
export const EXPIRE_ENTITLEMENTS_JOB = 'games.expire_entitlements';
export const RECOMPUTE_RARITY_JOB = 'achievements.recompute_rarity';
export const RESET_LEADERBOARDS_JOB = 'leaderboards.reset_periodic';

export function gamesService() {
  return {
    router,
    dataRights: ({ db }) => ({
      exportUser: async (userId) => ({
        entitlements: await exportUserEntitlements(db, userId),
        keys: await exportUserKeys(db, userId),
        achievements: await exportUserAchievements(db, userId),
        stats: await exportUserStats(db, userId),
        custom_data: await exportUserCustomData(db, userId),
        playtime: await exportUserPlaytime(db, userId),
      }),
      eraseUser: async (userId, trx) => {
        await eraseUserEntitlements(trx, userId);
        await eraseUserKeys(trx, userId);
        await eraseUserAchievements(trx, userId);
        await eraseUserStats(trx, userId);
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
            job: RECOMPUTE_RARITY_JOB,
            metrics: ctx.busMetrics,
            handler: async () => {
              const summary = await recomputeRarity(db, new Date());
              if (summary.achievements > 0) {
                log.info('achievement rarity recomputed', {
                  achievements: summary.achievements,
                  owners: summary.owners,
                });
              }
            },
            onError: (error) => {
              log.error('achievement rarity recompute failed', { error });
            },
          }),
        );

        stack.push(
          await consumeCron(bus, {
            job: RESET_LEADERBOARDS_JOB,
            metrics: ctx.busMetrics,
            handler: async () => {
              const now = new Date();
              const summary = await resetDueLeaderboards(db, now);
              const closed = await closeStalePlaytimeSessions(db, {
                staleAfterSeconds: STALE_PLAYTIME_SECONDS,
                now,
              });
              if (summary.boards > 0 || closed.closed > 0) {
                log.info('leaderboards rolled and stale sessions closed', {
                  boards: summary.boards,
                  playtime_sessions: closed.closed,
                });
                if (closed.closed > 0) ctx.outbox.wake();
              }
            },
            onError: (error) => {
              log.error('leaderboard reset failed', { error });
            },
          }),
        );

        stack.push(
          await consumeCron(bus, {
            job: RETENTION_JOB,
            metrics: ctx.busMetrics,
            handler: async () => {
              const now = new Date();
              const pruned = await pruneBusTables(db, ctx.config.bus);
              const attempts = await sweepRedeemAttempts(db, {
                retention: ctx.config.retention.tokens,
                now,
              });
              if (pruned.outbox > 0 || pruned.processedEvents > 0 || attempts > 0) {
                log.info('retention sweep finished', {
                  outbox: pruned.outbox,
                  processed_events: pruned.processedEvents,
                  redeem_attempts: attempts,
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
