import { consumeCron, consumeEvents, pruneBusTables, RpcError, serveRpc } from '@qtiauth/bus';
import { applyAuditLogPrivileges } from '@qtiauth/db';
import { queueEmail } from '@qtiauth/email';
import { AUDIT_EVENTS, loadEventCatalog } from '@qtiauth/events';
import { openGeoIp } from '@qtiauth/geoip';
import { untraced } from '@qtiauth/observability';
import {
  heldObjectPrefix,
  NOTIFICATION_ALLOWED_METHOD,
  notificationAllowedRequestSchema,
  RESOLVE_SESSION_METHOD,
  resolveSessionRequestSchema,
  type ResolveSessionResponse,
  type StartServiceOptions,
  type Stoppable,
  storageHealthCheck,
  unwind,
} from '@qtiauth/service-kit';
import { openTextFilter, resolveListsDir } from '@qtiauth/text-filter';
import { closeValkey, connectValkey } from '@qtiauth/valkey';

import { expireLocks, UNLOCK_JOB } from './account-locks.ts';
import { countAccountsByState, findAccount } from './accounts.ts';
import { AGE_RECOMPUTE_JOB, recomputeAgeBands } from './age-bands.ts';
import { AUDIT_CONSUMER, insertAuditRecord, sweepAuditLog } from './audit.ts';
import { attachBindStore, valkeyBindStore } from './bind-state.ts';
import { sweepChallenges } from './challenges.ts';
import { eraseUser, exportUser, storeHeldSnapshot } from './data-rights.ts';
import type { Database } from './database.ts';
import { sweepTokens } from './email-tokens.ts';
import { EXPORT_RESUME_JOB, sweepExports } from './exports.ts';
import { sweepAuthFailures } from './failures.ts';
import { ACTIVITY_SUMMARY_JOB, sweepFamilySessions } from './family.ts';
import { loadFilterOverlay, sweepFilterDecisions } from './filter.ts';
import { attachTextFilter } from './filter-state.ts';
import {
  resumeDataExports,
  sendFamilyActivitySummaries,
  sendGraduationNotices,
  sendGuardianRemovalReminders,
} from './flows.ts';
import { attachGeoIp } from './geoip-state.ts';
import { GRADUATION_JOB, REMOVAL_REMINDERS_JOB } from './graduation.ts';
import { iso } from './iso.ts';
import {
  LEDGER_PRUNE_JOB,
  ledgerDestination,
  ledgerKeepUntil,
  flushLedgerOutbox,
  pruneLedgerDestination,
  sweepLedgerOutbox,
} from './ledger.ts';
import {
  countPendingLegalAcceptances,
  LEGAL_PUBLISH_JOB,
  loadAndSyncLegalDocuments,
  publishLegalVersions,
  queueLegalUpdateNotices,
} from './legal.ts';
import { resolveDocumentsDir } from './legal-documents.ts';
import {
  GET_LEGAL_HOLD_METHOD,
  getActiveHold,
  getHoldRequestSchema,
  LIFT_LEGAL_HOLD_METHOD,
  liftHoldRequestSchema,
  liftLegalHold,
  PLACE_LEGAL_HOLD_METHOD,
  placeHoldRequestSchema,
  placeLegalHold,
} from './legal-holds.ts';
import { PURGE_JOB, purgeExpiredDeletions } from './lifecycle.ts';
import { identityMetrics } from './metrics.ts';
import { listedNotifications, openNotificationCatalog } from './notification-registry.ts';
import { IDENTITY_NOTIFICATIONS, notificationAllowed } from './notifications.ts';
import { attachOauthStore, valkeyOauthStore } from './oauth-state.ts';
import { EXPIRE_PENDING_JOB, expirePendingConsents } from './parental.ts';
import { openPermissionCatalog } from './permission-registry.ts';
import { anySocialEnabled } from './providers.ts';
import { seedRoles } from './roles.ts';
import { sweepSecurityEvents } from './security.ts';
import { type Context, definition, router } from './service.ts';
import { countActiveSessions, resolveSession, sweepSessions } from './sessions.ts';
import { accountOrigin, encryptionKey, sessionSecuritySettings } from './settings.ts';
import { sharedObjectStore } from './storage-state.ts';

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
    readinessChecks: (ctx) => {
      const store = sharedObjectStore(ctx);
      return store === null ? {} : { storage: storageHealthCheck(store) };
    },
    dataRights: (ctx) => {
      const store = sharedObjectStore(ctx);
      const ledger = ledgerDestination(ctx.config.backups, store);
      return {
        exportUser: (userId) => exportUser(ctx.db, userId),
        eraseUser: (userId, trx, event) =>
          eraseUser(trx, userId, {
            held: event.data['held'] === true,
            store,
            ledger,
            onLedgerError: (error) => {
              ctx.log.warn('deletion ledger write failed; it will be retried', { error });
            },
            now: new Date(),
          }),
      };
    },
    start: async (ctx: Context) => {
      const { config, log, bus, db } = ctx;
      // Emails link to the account surface; fail now rather than on the first send.
      accountOrigin(config);
      encryptionKey(config);
      const stack: Stoppable[] = [];
      const store = sharedObjectStore(ctx);
      if (store !== null) {
        if (config.storage.create_bucket) await store.ensureBucket();
        stack.push({ stop: () => store.close() });
      }
      const ledger = ledgerDestination(config.backups, store);
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
      openNotificationCatalog(ctx, IDENTITY_NOTIFICATIONS, permissions.registry);
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
      // Notices for anything published here go out on the next legal.publish tick, so a large
      // user base does not hold up startup.
      const published = await publishLegalVersions(db, { now: new Date() });
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
              const familySessions = await sweepFamilySessions(db, {
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
              const exports = await sweepExports(db, {
                store,
                ttl: config.accounts.export_ttl,
                now,
              });
              const pruned = await pruneBusTables(db, config.bus);
              log.info('retention sweep finished', {
                sessions,
                family_sessions: familySessions,
                email_tokens: tokens,
                auth_challenges: challenges,
                auth_failures: failures,
                session_security_events: securityEvents,
                filter_decisions: filterDecisions,
                audit,
                data_exports: exports,
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
              const published = await publishLegalVersions(db, { now: new Date() });
              if (published.length > 0) {
                ctx.outbox.wake();
                log.info('legal versions published', { published: published.length });
              }
              const notices = await queueLegalUpdateNotices(db, { config, bus });
              if (notices > 0) log.info('legal update notices queued', { notices });
            },
            onError: (error) => {
              log.error('legal publish failed', { error });
            },
          }),
        );

        stack.push(
          await consumeCron(bus, {
            job: EXPIRE_PENDING_JOB,
            metrics: ctx.busMetrics,
            handler: async () => {
              const expired = await expirePendingConsents(db, {
                pendingTtl: config.parental.pending_ttl,
                now: new Date(),
              });
              if (expired.length > 0) {
                identityMetrics(ctx.metrics).parentalConsent('expired', expired.length);
                identityMetrics(ctx.metrics).deletion('completed', expired.length);
                ctx.outbox.wake();
                log.info('unapproved child accounts expired', { expired: expired.length });
              }
            },
            onError: (error) => {
              log.error('pending parental consent expiry failed', { error });
            },
          }),
        );

        stack.push(
          await consumeCron(bus, {
            job: ACTIVITY_SUMMARY_JOB,
            metrics: ctx.busMetrics,
            handler: async (tick) => {
              const sent = await sendFamilyActivitySummaries(ctx, new Date(tick.data.scheduled_at));
              if (sent > 0) {
                ctx.outbox.wake();
                log.info('family activity summaries queued', { sent });
              }
            },
            onError: (error) => {
              log.error('family activity summary failed', { error });
            },
          }),
        );

        stack.push(
          await consumeCron(bus, {
            job: GRADUATION_JOB,
            metrics: ctx.busMetrics,
            handler: async (tick) => {
              const sent = await sendGraduationNotices(ctx, new Date(tick.data.scheduled_at));
              if (sent > 0) {
                identityMetrics(ctx.metrics).graduation('notified', sent);
                ctx.outbox.wake();
                log.info('graduation notices queued', { sent });
              }
            },
            onError: (error) => {
              log.error('graduation notices failed', { error });
            },
          }),
        );

        stack.push(
          await consumeCron(bus, {
            job: REMOVAL_REMINDERS_JOB,
            metrics: ctx.busMetrics,
            handler: async (tick) => {
              const sent = await sendGuardianRemovalReminders(
                ctx,
                new Date(tick.data.scheduled_at),
              );
              if (sent > 0) {
                ctx.outbox.wake();
                log.info('guardian removal reminders queued', { sent });
              }
            },
            onError: (error) => {
              log.error('guardian removal reminders failed', { error });
            },
          }),
        );

        stack.push(
          await consumeCron(bus, {
            job: PURGE_JOB,
            metrics: ctx.busMetrics,
            handler: async () => {
              const deleted = await purgeExpiredDeletions(db, {
                grace: config.accounts.deletion_grace,
                now: new Date(),
              });
              if (deleted.length > 0) {
                identityMetrics(ctx.metrics).deletion('completed', deleted.length);
                ctx.outbox.wake();
                log.info('pending deletions completed', { deleted: deleted.length });
              }
            },
            onError: (error) => {
              log.error('pending deletion purge failed', { error });
            },
          }),
        );

        stack.push(
          await consumeCron(bus, {
            job: EXPORT_RESUME_JOB,
            metrics: ctx.busMetrics,
            handler: async () => {
              const resumed = await resumeDataExports(ctx);
              if (resumed > 0) log.info('abandoned data exports resumed', { resumed });
            },
            onError: (error) => {
              log.error('data export resume failed', { error });
            },
          }),
        );

        stack.push(
          await consumeCron(bus, {
            job: LEDGER_PRUNE_JOB,
            metrics: ctx.busMetrics,
            handler: async () => {
              const now = new Date();
              const cutoff = ledgerKeepUntil(config.backups.retention, now);
              const flushed = await flushLedgerOutbox(db, ledger, now);
              const pruned = await pruneLedgerDestination(ledger, cutoff);
              const outbox = await sweepLedgerOutbox(db, cutoff);
              log.info('deletion ledger pruned', { flushed, pruned, outbox });
            },
            onError: (error) => {
              log.error('deletion ledger prune failed', { error });
            },
          }),
        );

        const onHoldError = (error: unknown) => {
          log.error('legal hold rpc failed', { error });
        };
        stack.push(
          serveRpc(bus, {
            method: PLACE_LEGAL_HOLD_METHOD,
            handler: async (request) => {
              const parsed = placeHoldRequestSchema.safeParse(request);
              if (!parsed.success)
                throw new RpcError('bad_request', 'user_id and reason are required');
              const account = await findAccount(db, parsed.data.user_id);
              if (!account || account.state === 'deleted') {
                throw new RpcError('not_found', 'No such user');
              }
              const result = await placeLegalHold(db, {
                userId: parsed.data.user_id,
                reason: parsed.data.reason,
                ...(parsed.data.case_id === undefined ? {} : { caseId: parsed.data.case_id }),
                actor: { type: 'service', id: 'safety' },
                now: new Date(),
              });
              if (result.status === 'conflict') {
                throw new RpcError('conflict', 'A legal hold is already in place');
              }
              if (store !== null) await storeHeldSnapshot(db, store, parsed.data.user_id);
              return {
                hold: {
                  id: result.hold.id,
                  user_id: result.hold.user_id,
                  reason: result.hold.reason,
                  case_id: result.hold.case_id,
                  placed_at: result.hold.placed_at.toISOString(),
                  lifted_at: null,
                },
              };
            },
            onError: onHoldError,
          }),
        );
        stack.push(
          serveRpc(bus, {
            method: LIFT_LEGAL_HOLD_METHOD,
            handler: async (request) => {
              const parsed = liftHoldRequestSchema.safeParse(request);
              if (!parsed.success) throw new RpcError('bad_request', 'user_id is required');
              const lifted = await liftLegalHold(db, {
                userId: parsed.data.user_id,
                ...(parsed.data.hold_id === undefined ? {} : { holdId: parsed.data.hold_id }),
                now: new Date(),
              });
              if (!lifted) throw new RpcError('not_found', 'No active legal hold');
              const account = await findAccount(db, parsed.data.user_id);
              if ((account === undefined || account.state === 'deleted') && store !== null) {
                await store.deletePrefix(heldObjectPrefix(parsed.data.user_id));
              }
              return { lifted: true };
            },
            onError: onHoldError,
          }),
        );
        stack.push(
          serveRpc(bus, {
            method: GET_LEGAL_HOLD_METHOD,
            handler: async (request) => {
              const parsed = getHoldRequestSchema.safeParse(request);
              if (!parsed.success) throw new RpcError('bad_request', 'user_id is required');
              const hold = await getActiveHold(db, parsed.data.user_id);
              return {
                hold:
                  hold === undefined
                    ? null
                    : {
                        id: hold.id,
                        user_id: hold.user_id,
                        reason: hold.reason,
                        case_id: hold.case_id,
                        placed_at: hold.placed_at.toISOString(),
                        lifted_at: iso(hold.lifted_at),
                      },
              };
            },
            onError: onHoldError,
          }),
        );
        stack.push(
          serveRpc(bus, {
            method: NOTIFICATION_ALLOWED_METHOD,
            handler: async (request) => {
              const parsed = notificationAllowedRequestSchema.safeParse(request);
              if (!parsed.success) {
                throw new RpcError('bad_request', 'user_id and category are required');
              }
              return {
                allowed: await notificationAllowed(db, {
                  userId: parsed.data.user_id,
                  category: parsed.data.category,
                  catalog: listedNotifications(ctx),
                }),
              };
            },
            onError: (error) => {
              log.error('notification preference rpc failed', { error });
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
