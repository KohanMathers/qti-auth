import { consumeCron, consumeEvents, pruneBusTables, RpcError, serveRpc } from '@qtiauth/bus';
import { applyAuditLogPrivileges } from '@qtiauth/db';
import { queueEmail } from '@qtiauth/email';
import { AUDIT_EVENTS, loadEventCatalog } from '@qtiauth/events';
import { openGeoIp } from '@qtiauth/geoip';
import { untraced } from '@qtiauth/observability';
import {
  RESOLVE_SESSION_METHOD,
  resolveSessionRequestSchema,
  type ResolveSessionResponse,
  type StartServiceOptions,
  type Stoppable,
  unwind,
} from '@qtiauth/service-kit';
import { openTextFilter, resolveListsDir } from '@qtiauth/text-filter';
import { closeValkey, connectValkey } from '@qtiauth/valkey';

import { expireLocks, UNLOCK_JOB } from './account-locks.ts';
import { countAccountsByState } from './accounts.ts';
import { AGE_RECOMPUTE_JOB, recomputeAgeBands } from './age-bands.ts';
import { AUDIT_CONSUMER, insertAuditRecord, sweepAuditLog } from './audit.ts';
import { attachBindStore, valkeyBindStore } from './bind-state.ts';
import { sweepChallenges } from './challenges.ts';
import type { Database } from './database.ts';
import { eraseUser, exportUser } from './data-rights.ts';
import { sweepTokens } from './email-tokens.ts';
import { sweepAuthFailures } from './failures.ts';
import { loadFilterOverlay, sweepFilterDecisions } from './filter.ts';
import { attachTextFilter } from './filter-state.ts';
import { attachGeoIp } from './geoip-state.ts';
import {
  countPendingLegalAcceptances,
  LEGAL_PUBLISH_JOB,
  loadAndSyncLegalDocuments,
  publishLegalVersions,
  queueLegalUpdateNotices,
} from './legal.ts';
import { resolveDocumentsDir } from './legal-documents.ts';
import { identityMetrics } from './metrics.ts';
import { attachOauthStore, valkeyOauthStore } from './oauth-state.ts';
import { openPermissionCatalog } from './permission-registry.ts';
import { anySocialEnabled } from './providers.ts';
import { seedRoles } from './roles.ts';
import { sweepSecurityEvents } from './security.ts';
import { type Context, definition, router } from './service.ts';
import { countActiveSessions, resolveSession, sweepSessions } from './sessions.ts';
import { accountOrigin, encryptionKey, sessionSecuritySettings } from './settings.ts';

export const RETENTION_JOB = 'retention.sweep';
export const STATS_INTERVAL = 60_000;

export interface IdentityOptions {
  statsInterval?: number;
}

function startStats(ctx: Context, interval: number): Stoppable {
  const metrics = identityMetrics(ctx.metrics);
  const refresh = () =>
    untraced(async () => {
      const [accounts, sessions, legalPending] = await Promise.all([
        countAccountsByState(ctx.db),
        countActiveSessions(ctx.db, new Date(), ctx.config.cookies.idle_timeout),
        countPendingLegalAcceptances(ctx.db, new Date()),
      ]);
      metrics.accounts(accounts);
      metrics.activeSessions(sessions);
      metrics.legalAcceptancePending(legalPending);
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
      const geoip = openGeoIp(config.geoip, {
        onError: (error, path) => {
          log.warn('geoip database could not be read', { error, path });
        },
      });
      attachGeoIp(ctx, geoip);
      stack.push({
        stop: () => {
          geoip.close();
          return Promise.resolve();
        },
      });
      await seedRoles(db, config.roles);
      await applyAuditLogPrivileges(db, config.database);
      const permissions = openPermissionCatalog(ctx, definition.permissions);
      stack.push({ stop: permissions.stop });
      const textFilter = await openTextFilter(
        resolveListsDir(ctx.config_path, config.text_filter.lists_dir),
      );
      await loadFilterOverlay(db, textFilter);
      attachTextFilter(ctx, textFilter);
      log.info('text filter loaded', {
        dictionary: textFilter.lists.dictionary.size,
        blocked: textFilter.lists.blockExact.size + textFilter.lists.blockLoose.size,
        extra_block: textFilter.lists.blockExtra.size,
        allow: textFilter.lists.allow.size,
      });
      const legalDir = resolveDocumentsDir(ctx.config_path, config.legal.documents_dir);
      const synced = await loadAndSyncLegalDocuments(db, legalDir);
      const published = await publishLegalVersions(db, {
        now: new Date(),
        queueNotice: async (version) => {
          await queueLegalUpdateNotices(db, {
            version,
            config,
            bus,
            brand: config.branding,
          });
        },
      });
      if (published.length > 0) ctx.outbox.wake();
      log.info('legal documents synced', {
        documents: synced.documents,
        inserted: synced.inserted,
        published: published.length,
      });
      const valkey = connectValkey(config.valkey, 'identity', (error) => {
        log.warn('valkey client error', { error });
      });
      attachBindStore(ctx, valkeyBindStore(valkey));
      if (anySocialEnabled(config.features.auth.social)) {
        attachOauthStore(ctx, valkeyOauthStore(valkey));
      }
      stack.push({ stop: () => closeValkey(valkey) });
      try {
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
              const signals = parsed.data.signals;
              const resolved = await resolveSession(db, {
                tokenHash: parsed.data.binding_token_hash,
                cookieScope: parsed.data.cookie_scope,
                idleTimeout: config.cookies.idle_timeout,
                bands: config.age.bands,
                require2faFor: config.security.require_2fa_for_permissions,
                now: new Date(),
                ...(signals === undefined
                  ? {}
                  : {
                      signals: {
                        ip: signals.ip ?? '',
                        userAgent: signals.user_agent,
                        country: signals.country,
                        tlsFingerprint: signals.tls_fingerprint,
                        timezone: signals.timezone,
                        screen: signals.screen,
                        clientFingerprint: signals.client_fingerprint,
                      },
                    }),
                security: sessionSecuritySettings(config),
                lookupCountry: (ip) => geoip.lookup(ip),
              });
              if (resolved?.alert) {
                await queueEmail(bus, {
                  template: 'security_alert',
                  to: { address: resolved.alert.email },
                  locale: resolved.alert.locale ?? config.email.default_locale,
                  variables: {
                    summary: resolved.alert.summary,
                    place: resolved.alert.place,
                  },
                });
                ctx.outbox.wake();
              } else if (resolved?.unlocked) {
                ctx.outbox.wake();
              }
              return { session: resolved?.session ?? null };
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
              const securityEvents = await sweepSecurityEvents(db, {
                retention: config.retention.session_security_events,
                now,
              });
              const filterDecisions = await sweepFilterDecisions(db, {
                retention: config.retention.filter_decisions,
                now,
              });
              const audit = await sweepAuditLog(db, {
                retention: config.retention.audit,
                now,
              });
              const pruned = await pruneBusTables(db, config.bus);
              log.info('retention sweep finished', {
                sessions,
                email_tokens: tokens,
                auth_challenges: challenges,
                auth_failures: failures,
                session_security_events: securityEvents,
                filter_decisions: filterDecisions,
                audit,
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
            job: UNLOCK_JOB,
            metrics: ctx.busMetrics,
            handler: async () => {
              const unlocked = await expireLocks(db, new Date());
              if (unlocked.length > 0) {
                ctx.outbox.wake();
                log.info('expired locks lifted', { unlocked: unlocked.length });
              }
            },
            onError: (error) => {
              log.error('expired lock sweep failed', { error });
            },
          }),
        );

        stack.push(
          await consumeCron(bus, {
            job: AGE_RECOMPUTE_JOB,
            metrics: ctx.busMetrics,
            handler: async (tick) => {
              const now = new Date(tick.data.scheduled_at);
              const changed = await recomputeAgeBands(db, { bands: config.age.bands, now });
              if (changed > 0) {
                identityMetrics(ctx.metrics).ageBandChanged(changed);
                ctx.outbox.wake();
              }
              log.info('age band recompute finished', { changed });
            },
            onError: (error) => {
              log.error('age band recompute failed', { error });
            },
          }),
        );

        stack.push(
          await consumeEvents(bus, db, {
            name: AUDIT_CONSUMER,
            types: [AUDIT_EVENTS.recorded],
            startFrom: 'all',
            catalog: await loadEventCatalog(),
            metrics: ctx.busMetrics,
            handler: async (event, trx) => {
              if (await insertAuditRecord(trx, event)) {
                identityMetrics(ctx.metrics).auditRecorded();
              }
            },
            onError: (error) => {
              log.error('audit store failed', { error });
            },
          }),
        );

        stack.push(
          await consumeCron(bus, {
            job: LEGAL_PUBLISH_JOB,
            metrics: ctx.busMetrics,
            handler: async () => {
              const published = await publishLegalVersions(db, {
                now: new Date(),
                queueNotice: async (version) => {
                  await queueLegalUpdateNotices(db, {
                    version,
                    config,
                    bus,
                    brand: config.branding,
                  });
                },
              });
              if (published.length > 0) {
                ctx.outbox.wake();
                log.info('legal versions published', { published: published.length });
              }
            },
            onError: (error) => {
              log.error('legal publish failed', { error });
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
