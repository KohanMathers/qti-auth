import { consumeCron, pruneBusTables, RpcError, serveRpc } from '@qtiauth/bus';
import { untraced } from '@qtiauth/observability';
import {
  RESOLVE_SESSION_METHOD,
  resolveSessionRequestSchema,
  type ResolveSessionResponse,
  type StartServiceOptions,
  type Stoppable,
  unwind,
} from '@qtiauth/service-kit';
import { closeValkey, connectValkey } from '@qtiauth/valkey';

import { countAccountsByState } from './accounts.ts';
import { sweepChallenges } from './challenges.ts';
import type { Database } from './database.ts';
import { eraseUser, exportUser } from './data-rights.ts';
import { sweepTokens } from './email-tokens.ts';
import { sweepAuthFailures } from './failures.ts';
import { identityMetrics } from './metrics.ts';
import { attachOauthStore, valkeyOauthStore } from './oauth-state.ts';
import { anySocialEnabled } from './providers.ts';
import { type Context, type definition, router } from './service.ts';
import { countActiveSessions, resolveSession, sweepSessions } from './sessions.ts';
import { accountOrigin, encryptionKey } from './settings.ts';

export const RETENTION_JOB = 'retention.sweep';
export const STATS_INTERVAL = 60_000;

export interface IdentityOptions {
  statsInterval?: number;
}

function startStats(ctx: Context, interval: number): Stoppable {
  const metrics = identityMetrics(ctx.metrics);
  const refresh = () =>
    untraced(async () => {
      const [accounts, sessions] = await Promise.all([
        countAccountsByState(ctx.db),
        countActiveSessions(ctx.db, new Date(), ctx.config.cookies.idle_timeout),
      ]);
      metrics.accounts(accounts);
      metrics.activeSessions(sessions);
    }).catch((error: unknown) => {
      ctx.log.warn('account metrics refresh failed', { error });
    });
  void refresh();
  const timer = setInterval(() => void refresh(), interval);
  return {
    stop: () => {
      clearInterval(timer);
      return Promise.resolve();
    },
  };
}

export function identityService(options: IdentityOptions = {}) {
  return {
    router,
    dataRights: ({ db }) => ({
      exportUser: (userId) => exportUser(db, userId),
      eraseUser: (userId, trx) => eraseUser(trx, userId),
    }),
    start: async (ctx: Context) => {
      const { config, log, bus, db } = ctx;
      // Emails link to the account surface; fail now rather than on the first send.
      accountOrigin(config);
      encryptionKey(config);
      const stack: Stoppable[] = [];
      try {
        if (anySocialEnabled(config.features.auth.social)) {
          const valkey = connectValkey(config.valkey, 'identity', (error) => {
            log.warn('valkey client error', { error });
          });
          attachOauthStore(ctx, valkeyOauthStore(valkey));
          stack.push({ stop: () => closeValkey(valkey) });
        }
        stack.push(
          serveRpc<unknown, ResolveSessionResponse>(bus, {
            method: RESOLVE_SESSION_METHOD,
            handler: async (request) => {
              const parsed = resolveSessionRequestSchema.safeParse(request);
              if (!parsed.success) {
                throw new RpcError(
                  'bad_request',
                  'binding_token_hash and cookie_scope are required',
                );
              }
              return {
                session: await resolveSession(db, {
                  tokenHash: parsed.data.binding_token_hash,
                  cookieScope: parsed.data.cookie_scope,
                  idleTimeout: config.cookies.idle_timeout,
                  bands: config.age.bands,
                  require2faFor: config.security.require_2fa_for_permissions,
                  now: new Date(),
                }),
              };
            },
            onError: (error) => {
              log.error('session resolution failed', { error });
            },
          }),
        );

        stack.push(
          await consumeCron(bus, {
            job: RETENTION_JOB,
            metrics: ctx.busMetrics,
            handler: async () => {
              const now = new Date();
              const sessions = await sweepSessions(db, {
                retention: config.retention.sessions,
                idleTimeout: config.cookies.idle_timeout,
                now,
              });
              const tokens = await sweepTokens(db, { retention: config.retention.tokens, now });
              const challenges = await sweepChallenges(db, {
                retention: config.retention.tokens,
                now,
              });
              const failures = await sweepAuthFailures(db, {
                retention: config.retention.tokens,
                now,
              });
              const pruned = await pruneBusTables(db, config.bus);
              log.info('retention sweep finished', {
                sessions,
                email_tokens: tokens,
                auth_challenges: challenges,
                auth_failures: failures,
                outbox: pruned.outbox,
                processed_events: pruned.processedEvents,
              });
            },
            onError: (error) => {
              log.error('retention sweep failed', { error });
            },
          }),
        );

        stack.push(startStats(ctx, options.statsInterval ?? STATS_INTERVAL));
        log.info('identity started');
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
