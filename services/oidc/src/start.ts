import { consumeCron, consumeEvents, pruneBusTables, RpcError, serveRpc } from '@qtiauth/bus';
import { IDENTITY_EVENTS, loadEventCatalog } from '@qtiauth/events';
import { untraced } from '@qtiauth/observability';
import {
  CONNECTED_APPS_METHOD,
  type ConnectedAppsResponse,
  connectedAppsRequestSchema,
  DECIDE_APP_APPROVAL_METHOD,
  type DecideAppApprovalResponse,
  decideAppApprovalRequestSchema,
  PENDING_APP_APPROVALS_METHOD,
  type PendingAppApprovalsResponse,
  pendingAppApprovalsRequestSchema,
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
import {
  gameClientRequest,
  provisionGameClient,
  provisionGameClientRequest,
  PROVISION_GAME_CLIENT_METHOD,
  retireGameClient,
  RETIRE_GAME_CLIENT_METHOD,
  rotateGameClientSecret,
  ROTATE_GAME_CLIENT_METHOD,
} from './game-clients.ts';
import { decideAppApproval, listConnectedApps, listPendingAppApprovals } from './guardian.ts';
import { attachKeyring, kvKeySetStore, openKeyring } from './keys.ts';
import {
  createLogoutSender,
  handleIdentityEvent,
  LOGOUT_CONSUMER,
  LOGOUT_POLL_INTERVAL,
  RETRY_JOB,
  sweepLogoutDeliveries,
} from './logout.ts';
import type { LogoutHttp } from './logout-http.ts';
import { oidcMetrics } from './metrics.ts';
import { resolveAccessToken, sweepOauth } from './oauth.ts';
import { type Context, type definition, router } from './service.ts';
import { encryptionKey, issuerUrl } from './settings.ts';

export const RETENTION_JOB = 'retention.sweep';
export const KEY_ROTATION_JOB = 'keys.rotate';

export interface OidcOptions {
  keyStore?: Awaited<ReturnType<typeof kvKeySetStore>>;
  logoutHttp?: LogoutHttp;
  logoutPollInterval?: number;
}

export function oidcService(options: OidcOptions = {}) {
  return {
    router,
    dataRights: (ctx) => ({
      exportUser: (userId) => exportUser(ctx.db, userId),
      eraseUser: (userId, trx) =>
        eraseUser(trx, userId, {
          deliverLogout: ctx.config.features.oidc.backchannel_logout.enabled,
        }),
    }),
    start: async (ctx: Context) => {
      const { config, log, bus, db } = ctx;
      issuerUrl(config);
      const key = encryptionKey(config);
      const stack: Stoppable[] = [];
      const metrics = oidcMetrics(ctx.metrics);
      const deliverLogout = config.features.oidc.backchannel_logout.enabled;
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
          serveRpc<unknown, PendingAppApprovalsResponse>(bus, {
            method: PENDING_APP_APPROVALS_METHOD,
            handler: async (request) => {
              const parsed = pendingAppApprovalsRequestSchema.safeParse(request);
              if (!parsed.success) throw new RpcError('bad_request', 'user_id is required');
              return { items: await listPendingAppApprovals(db, parsed.data.user_id) };
            },
            onError: (error) => {
              log.error('pending app approvals lookup failed', { error });
            },
          }),
        );

        stack.push(
          serveRpc<unknown, DecideAppApprovalResponse>(bus, {
            method: DECIDE_APP_APPROVAL_METHOD,
            handler: async (request) => {
              const parsed = decideAppApprovalRequestSchema.safeParse(request);
              if (!parsed.success) {
                throw new RpcError('bad_request', 'user_id, request_id and approve are required');
              }
              return decideAppApproval(ctx, {
                userId: parsed.data.user_id,
                requestId: parsed.data.request_id,
                approve: parsed.data.approve,
              });
            },
            onError: (error) => {
              log.error('app approval decision failed', { error });
            },
          }),
        );

        stack.push(
          serveRpc(bus, {
            method: PROVISION_GAME_CLIENT_METHOD,
            handler: async (request) => {
              const parsed = provisionGameClientRequest.safeParse(request);
              if (!parsed.success) {
                throw new RpcError('bad_request', 'game_id, name and actor are required');
              }
              const result = await provisionGameClient(db, {
                gameId: parsed.data.game_id,
                name: parsed.data.name,
                actor: parsed.data.actor,
                now: new Date(),
                knownScopes: Object.keys(config.oidc.scopes),
              });
              if (result.status === 'invalid') {
                throw new RpcError('invalid_scope', 'the game_server scope is not configured');
              }
              return result;
            },
            onError: (error) => {
              log.error('game client provisioning failed', { error });
            },
          }),
        );

        stack.push(
          serveRpc(bus, {
            method: ROTATE_GAME_CLIENT_METHOD,
            handler: async (request) => {
              const parsed = gameClientRequest.safeParse(request);
              if (!parsed.success) {
                throw new RpcError('bad_request', 'game_id and actor are required');
              }
              const result = await rotateGameClientSecret(db, {
                gameId: parsed.data.game_id,
                actor: parsed.data.actor,
                now: new Date(),
              });
              if (result.status === 'not_found') {
                throw new RpcError('not_found', 'no game server client for this game');
              }
              return result;
            },
            onError: (error) => {
              log.error('game client rotation failed', { error });
            },
          }),
        );

        stack.push(
          serveRpc(bus, {
            method: RETIRE_GAME_CLIENT_METHOD,
            handler: async (request) => {
              const parsed = gameClientRequest.safeParse(request);
              if (!parsed.success) {
                throw new RpcError('bad_request', 'game_id and actor are required');
              }
              return retireGameClient(db, {
                gameId: parsed.data.game_id,
                actor: parsed.data.actor,
                now: new Date(),
              });
            },
            onError: (error) => {
              log.error('game client retirement failed', { error });
            },
          }),
        );

        stack.push(
          serveRpc<unknown, ConnectedAppsResponse>(bus, {
            method: CONNECTED_APPS_METHOD,
            handler: async (request) => {
              const parsed = connectedAppsRequestSchema.safeParse(request);
              if (!parsed.success) {
                throw new RpcError('bad_request', 'user_id, since and until are required');
              }
              return {
                items: await listConnectedApps(db, {
                  userId: parsed.data.user_id,
                  since: new Date(parsed.data.since),
                  until: new Date(parsed.data.until),
                }),
              };
            },
            onError: (error) => {
              log.error('connected apps lookup failed', { error });
            },
          }),
        );

        stack.push(
          await consumeEvents(bus, db, {
            name: LOGOUT_CONSUMER,
            types: [
              IDENTITY_EVENTS.sessionRevoked,
              IDENTITY_EVENTS.userBanned,
              IDENTITY_EVENTS.userLocked,
            ],
            startFrom: 'new',
            catalog: await loadEventCatalog(),
            metrics: ctx.busMetrics,
            handler: async (event, trx) => {
              await handleIdentityEvent(trx, event, {
                deliver: deliverLogout,
                now: new Date(),
              });
            },
            onError: (error) => {
              log.error('back-channel logout failed', { error });
            },
          }),
        );

        const sender = createLogoutSender({
          ctx,
          log,
          metrics,
          ...(options.logoutHttp === undefined ? {} : { http: options.logoutHttp }),
        });
        const poll = () =>
          untraced(async () => {
            await sender.attemptDue();
          }).catch((error: unknown) => {
            log.error('back-channel logout poll failed', { error });
          });
        void poll();
        const timer = setInterval(
          () => void poll(),
          options.logoutPollInterval ?? LOGOUT_POLL_INTERVAL,
        );
        stack.push({
          stop: () => {
            clearInterval(timer);
            return Promise.resolve();
          },
        });

        stack.push(
          await consumeCron(bus, {
            job: RETRY_JOB,
            metrics: ctx.busMetrics,
            handler: async () => {
              const attempted = await sender.attemptDue();
              if (attempted > 0) log.info('back-channel logout retries attempted', { attempted });
            },
            onError: (error) => {
              log.error('back-channel logout retry job failed', { error });
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
              const logouts = await sweepLogoutDeliveries(db, {
                retention: config.retention.delivery_logs,
                now,
              });
              const pruned = await pruneBusTables(db, config.bus);
              log.info('retention sweep finished', {
                ...oauth,
                logout_deliveries: logouts,
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
