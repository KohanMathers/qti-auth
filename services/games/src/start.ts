import { consumeCron, pruneBusTables } from '@qtiauth/bus';
import {
  type ObjectStore,
  type StartServiceOptions,
  type Stoppable,
  storageHealthCheck,
  unwind,
} from '@qtiauth/service-kit';

import { eraseUserAchievements, exportUserAchievements, recomputeRarity } from './achievements.ts';
import { eraseUserCloudSaves, exportUserCloudSaves, sweepStalePending } from './cloud-saves.ts';
import type { Database } from './database.ts';
import {
  eraseUserEntitlements,
  expireEntitlements,
  exportUserEntitlements,
} from './entitlements.ts';
import { eraseUserKeys, exportUserKeys, sweepRedeemAttempts } from './keys.ts';
import { eraseUserLeases, exportUserLeases, sweepExpiredRevocations } from './licensing.ts';
import {
  attachKeyring,
  kvKeySetStore as openLicensingKeyStore,
  type KeySetStore as LicensingKeySetStore,
  openKeyring as openLicensingKeyring,
} from './licensing-keys.ts';
import { gamesMetrics } from './metrics.ts';
import { type Context, type definition, router } from './service.ts';
import { gamesEncryptionKey } from './settings.ts';
import {
  closeStalePlaytimeSessions,
  eraseUserStats,
  exportUserCustomData,
  exportUserPlaytime,
  exportUserStats,
  resetDueLeaderboards,
} from './stats.ts';
import { openObjectStore } from './storage-state.ts';

const STALE_PLAYTIME_SECONDS = 300;

export const RETENTION_JOB = 'retention.sweep';
export const EXPIRE_ENTITLEMENTS_JOB = 'games.expire_entitlements';
export const RECOMPUTE_RARITY_JOB = 'achievements.recompute_rarity';
export const RESET_LEADERBOARDS_JOB = 'leaderboards.reset_periodic';
export const LICENSE_KEY_ROTATION_JOB = 'keys.rotate';

export interface GamesOptions {
  licensingKeyStore?: LicensingKeySetStore;
  objectStore?: ObjectStore | null;
}

export function gamesService(options: GamesOptions = {}) {
  const storeOf = (ctx: Context) => openObjectStore(ctx, options.objectStore);
  return {
    router,
    readinessChecks: (ctx: Context) => {
      const store = storeOf(ctx);
      return store === null ? {} : { storage: storageHealthCheck(store) };
    },
    dataRights: (ctx: Context) => ({
      exportUser: async (userId) => ({
        entitlements: await exportUserEntitlements(ctx.db, userId),
        keys: await exportUserKeys(ctx.db, userId),
        achievements: await exportUserAchievements(ctx.db, userId),
        stats: await exportUserStats(ctx.db, userId),
        custom_data: await exportUserCustomData(ctx.db, userId),
        playtime: await exportUserPlaytime(ctx.db, userId),
        license_leases: await exportUserLeases(ctx.db, userId),
        cloud_saves: await exportUserCloudSaves(ctx.db, userId),
      }),
      eraseUser: async (userId, trx) => {
        await eraseUserEntitlements(trx, userId);
        await eraseUserKeys(trx, userId);
        await eraseUserAchievements(trx, userId);
        await eraseUserStats(trx, userId);
        await eraseUserLeases(trx, userId);
        await eraseUserCloudSaves(trx, userId, storeOf(ctx));
      },
    }),
    start: async (ctx: Context) => {
      const { bus, config, db, log } = ctx;
      const metrics = gamesMetrics(ctx.metrics);
      const stack: Stoppable[] = [];
      const store = storeOf(ctx);
      try {
        if (store !== null) {
          if (ctx.config.storage.enabled && ctx.config.storage.create_bucket)
            await store.ensureBucket();
          stack.push({ stop: () => store.close() });
        }
        if (config.features.games.licensing.enabled) {
          const keyring = await openLicensingKeyring({
            store: options.licensingKeyStore ?? (await openLicensingKeyStore(bus)),
            encryptionKey: gamesEncryptionKey(config),
            algorithm: config.games.licensing.signing.algorithm,
            rotateAfter: config.games.licensing.signing.rotate_after,
            retainAfterRotation: config.games.licensing.signing.retain_after_rotation,
            onError: (error) => {
              log.warn('licensing keys refresh failed', { error });
            },
          });
          attachKeyring(ctx, keyring);
          metrics.licenseKeyLoaded(keyring.activeKeyCreatedAt());

          const refreshKeys = setInterval(() => {
            keyring.refresh().then(
              () => {
                metrics.licenseKeyLoaded(keyring.activeKeyCreatedAt());
              },
              (error: unknown) => {
                log.warn('licensing keys refresh failed', { error });
              },
            );
          }, config.games.licensing.signing.refresh);
          stack.push({
            stop: () => {
              clearInterval(refreshKeys);
              return Promise.resolve();
            },
          });

          stack.push(
            await consumeCron(bus, {
              job: LICENSE_KEY_ROTATION_JOB,
              metrics: ctx.busMetrics,
              handler: async () => {
                if (await keyring.rotateIfDue()) {
                  metrics.licenseKeyRotated();
                  log.info('licensing key rotated', { kid: keyring.signingKey().kid });
                }
                metrics.licenseKeyLoaded(keyring.activeKeyCreatedAt());
              },
              onError: (error) => {
                log.error('licensing key rotation failed', { error });
              },
            }),
          );
        }
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
              const revocations = await sweepExpiredRevocations(db, now);
              const stalePending = await sweepStalePending(db, store, {
                olderThan: new Date(now.getTime() - config.games.cloud_saves.upload_ttl),
              });
              if (
                pruned.outbox > 0 ||
                pruned.processedEvents > 0 ||
                attempts > 0 ||
                revocations > 0 ||
                stalePending.deleted > 0
              ) {
                log.info('retention sweep finished', {
                  outbox: pruned.outbox,
                  processed_events: pruned.processedEvents,
                  redeem_attempts: attempts,
                  license_revocations: revocations,
                  cloud_save_pending: stalePending.deleted,
                });
              }
            },
            onError: (error) => {
              log.error('retention sweep failed', { error });
            },
          }),
        );

        log.info('games started', {
          licensing: config.features.games.licensing.enabled,
          cloud_saves: config.features.games.cloud_saves.enabled && store !== null,
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
