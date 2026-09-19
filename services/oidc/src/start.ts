import { consumeCron, pruneBusTables, RpcError, serveRpc } from '@qtiauth/bus';
import {
  RESOLVE_ACCESS_TOKEN_METHOD,
  resolveAccessTokenRequestSchema,
  type ResolveAccessTokenResponse,
  type StartServiceOptions,
  type Stoppable,
  unwind,
} from '@qtiauth/service-kit';

import { seedClients } from './clients.ts';
import { eraseUser, exportUser } from './data-rights.ts';
import type { Database } from './database.ts';
import { attachKeyring, kvKeySetStore, openKeyring } from './keys.ts';
import { oidcMetrics } from './metrics.ts';
import { resolveAccessToken, sweepOauth } from './oauth.ts';
import { type Context, type definition, router } from './service.ts';
import { encryptionKey, issuerUrl } from './settings.ts';

export const RETENTION_JOB = 'retention.sweep';
export const KEY_ROTATION_JOB = 'keys.rotate';

export interface OidcOptions {
  keyStore?: Awaited<ReturnType<typeof kvKeySetStore>>;
}

export function oidcService(options: OidcOptions = {}) {
  return {
    router,
    dataRights: (ctx) => ({
      exportUser: (userId) => exportUser(ctx.db, userId),
      eraseUser: (userId, trx) => eraseUser(trx, userId),
    }),
    start: async (ctx: Context) => {
      const { config, log, bus, db } = ctx;
      issuerUrl(config);
      const key = encryptionKey(config);
      const stack: Stoppable[] = [];
      const metrics = oidcMetrics(ctx.metrics);
      try {
        const keyring = await openKeyring({
          store: options.keyStore ?? (await kvKeySetStore(bus)),
          encryptionKey: key,
          algorithm: config.oidc.signing.algorithm,
          rotateAfter: config.oidc.signing.rotate_after,
          retainAfterRotation: config.oidc.signing.retain_after_rotation,
          onError: (error) => {
            log.warn('oidc keys refresh failed', { error });
          },
        });
        attachKeyring(ctx, keyring);
        metrics.keyLoaded(keyring.activeKeyCreatedAt());

        const seeded = await seedClients(db, config.oidc.clients, new Date());
        if (seeded > 0) log.info('seeded oauth clients', { inserted: seeded });

        const refreshKeys = setInterval(() => {
          keyring.refresh().then(
            () => {
              metrics.keyLoaded(keyring.activeKeyCreatedAt());
            },
            (error: unknown) => {
              log.warn('oidc keys refresh failed', { error });
            },
          );
        }, config.oidc.signing.refresh);
        stack.push({
          stop: () => {
            clearInterval(refreshKeys);
            return Promise.resolve();
          },
        });

        stack.push(
          await consumeCron(bus, {
            job: KEY_ROTATION_JOB,
            metrics: ctx.busMetrics,
            handler: async () => {
              if (await keyring.rotateIfDue()) {
                metrics.keyRotated();
                log.info('oidc key rotated', { kid: keyring.signingKey().kid });
              }
              metrics.keyLoaded(keyring.activeKeyCreatedAt());
            },
            onError: (error) => {
              log.error('oidc key rotation failed', { error });
            },
          }),
        );

        stack.push(
          serveRpc<unknown, ResolveAccessTokenResponse>(bus, {
            method: RESOLVE_ACCESS_TOKEN_METHOD,
            handler: async (request) => {
              const parsed = resolveAccessTokenRequestSchema.safeParse(request);
              if (!parsed.success) throw new RpcError('bad_request', 'token is required');
              return { token: await resolveAccessToken(ctx, parsed.data.token) };
            },
            onError: (error) => {
              log.error('access token resolution failed', { error });
            },
          }),
        );

        stack.push(
          await consumeCron(bus, {
            job: RETENTION_JOB,
            metrics: ctx.busMetrics,
            handler: async () => {
              const now = new Date();
              const oauth = await sweepOauth(db, { retention: config.retention.oauth, now });
              const pruned = await pruneBusTables(db, config.bus);
              log.info('retention sweep finished', {
                ...oauth,
                outbox: pruned.outbox,
                processed_events: pruned.processedEvents,
              });
            },
            onError: (error) => {
              log.error('retention sweep failed', { error });
            },
          }),
        );

        log.info('oidc started');
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
