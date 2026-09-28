import { consumeCron } from '@qtiauth/bus';
import { untraced } from '@qtiauth/observability';
import { type StartServiceOptions, type Stoppable, unwind } from '@qtiauth/service-kit';
import { tryOpenObjectStore } from '@qtiauth/storage';

import { backupDestination } from './destination.ts';
import { pgDumpVersion } from './dump.ts';
import { prometheusBackupMetrics } from './metrics.ts';
import { enforceRetention } from './retention.ts';
import { runBackup } from './run.ts';
import { type Context, type definition, router } from './service.ts';
import { backupEncryptionKey } from './settings.ts';

export const BACKUP_JOB = 'backup.run';

export function backupService() {
  return {
    router,
    start: async (ctx: Context) => {
      const { config, log, bus } = ctx;
      const key = backupEncryptionKey(config);
      if (config.backups.admin_password === '') {
        throw new Error(
          'backups.admin_password is empty; the backup service reads every schema as an administrator',
        );
      }
      const store = tryOpenObjectStore(config.storage);
      const destination = backupDestination(config.backups, config.storage, store);
      const metrics = prometheusBackupMetrics(ctx.metrics);
      const stack: Stoppable[] = [];
      try {
        if (store) stack.push({ stop: () => store.close() });

        const dumpVersion = await pgDumpVersion(config.backups.pg_dump);
        const serviceVersions = { backup: ctx.version };

        stack.push(
          await consumeCron(bus, {
            job: BACKUP_JOB,
            metrics: ctx.busMetrics,
            handler: async () => {
              const startedAt = Date.now();
              try {
                const handle = await untraced(() =>
                  runBackup({
                    config,
                    destination,
                    key,
                    store,
                    serviceVersions,
                    log,
                    postgresVersion: dumpVersion,
                    now: new Date(),
                  }),
                );
                const retention = await enforceRetention({
                  destination,
                  retention: config.backups.retention,
                  now: new Date(),
                });
                metrics.runs('succeeded');
                metrics.duration((Date.now() - startedAt) / 1000);
                metrics.size(handle.size);
                metrics.lastRun(handle.createdAt);
                metrics.retention('kept', retention.kept.length);
                if (retention.deleted.length > 0) {
                  metrics.retention('deleted', retention.deleted.length);
                }
                log.info('backup finished', {
                  archive_id: handle.id,
                  kept: retention.kept.length,
                  deleted: retention.deleted.length,
                });
              } catch (error) {
                metrics.runs('failed');
                metrics.duration((Date.now() - startedAt) / 1000);
                log.error('backup failed', { error });
                throw error;
              }
            },
            onError: (error) => {
              log.error('backup job errored', { error });
            },
          }),
        );

        return stack;
      } catch (error) {
        await unwind(stack.map((entry) => () => entry.stop()));
        throw error;
      }
    },
  } satisfies StartServiceOptions<typeof definition, unknown>;
}

export function attachStorage(config: Context['config']) {
  return tryOpenObjectStore(config.storage);
}
