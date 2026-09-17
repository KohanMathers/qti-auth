import { consumeCron, pruneBusTables, RpcError, serveRpc } from '@qtiauth/bus';
import { untraced } from '@qtiauth/observability';
import type { StartServiceOptions, Stoppable } from '@qtiauth/service-kit';
import * as z from 'zod';

import { countAccountsByState } from './accounts.ts';
import type { Database } from './database.ts';
import { eraseUser, exportUser } from './data-rights.ts';
import { sweepTokens } from './magic-links.ts';
import { identityMetrics } from './metrics.ts';
import { type Context, type definition, router } from './service.ts';
import { accountOrigin } from './settings.ts';
import { countActiveSessions, resolveSession, sweepSessions } from './sessions.ts';

export const RETENTION_JOB = 'retention.sweep';
export const RESOLVE_SESSION_METHOD = 'resolve_session';
export const STATS_INTERVAL = 60_000;

const resolveSessionRequest = z.object({
  binding_token_hash: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  cookie_scope: z.string().max(253),
});

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
      accountOrigin(config);
      const stack: Stoppable[] = [];
      try {
        stack.push(
          serveRpc(bus, {
            method: RESOLVE_SESSION_METHOD,
            handler: async (request) => {
              const parsed = resolveSessionRequest.safeParse(request);
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
              const pruned = await pruneBusTables(db, config.bus);
              log.info('retention sweep finished', {
                sessions,
                email_tokens: tokens,
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
        for (const task of stack.reverse()) await task.stop();
        throw error;
      }
    },
  } satisfies StartServiceOptions<typeof definition, Database>;
}
