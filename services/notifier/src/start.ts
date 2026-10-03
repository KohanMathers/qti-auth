import { dirname, resolve } from 'node:path';

import {
  consumeCron,
  consumeEvents,
  consumeWork,
  InvalidMessageError,
  pruneBusTables,
} from '@qtiauth/bus';
import type { QtiauthConfig } from '@qtiauth/config';
import { EMAIL_PRIORITIES, EMAIL_TEMPLATES, emailQueue, queueEmail } from '@qtiauth/email';
import { loadEventCatalog } from '@qtiauth/events';
import { untraced } from '@qtiauth/observability';
import { type StartServiceOptions, type Stoppable, unwind } from '@qtiauth/service-kit';

import type { Database } from './database.ts';
import {
  createWebhookSender,
  enqueueEvent,
  eraseWebhookDeliveries,
  exportWebhookDeliveries,
  RETRY_JOB,
} from './deliver.ts';
import {
  databaseDeliveryLog,
  eraseDeliveries,
  exportDeliveries,
  sweepDeliveries,
} from './deliveries.ts';
import { seedEndpoints, sweepWebhookDeliveries } from './endpoints.ts';
import { WEBHOOK_EVENT_TYPES } from './event-names.ts';
import { createWebhookHttp, type WebhookHttp } from './http.ts';
import { prometheusNotifierMetrics } from './metrics.ts';
import { adminOrigins } from './origin.ts';
import { createProvider, type EmailConfig, type EmailProvider } from './providers.ts';
import { createEmailSender, EmailSendError } from './sender.ts';
import { type Context, type definition, router } from './service.ts';
import type { DnsLookup } from './ssrf.ts';
import {
  brandFromConfig,
  DEFAULT_TEMPLATES_DIR,
  loadTemplates,
  type TemplateSet,
} from './templates.ts';

export const RETENTION_JOB = 'retention.sweep';
export const WEBHOOK_POLL_INTERVAL = 1_000;

export interface NotifierOptions {
  configDir?: string;
  defaultTemplatesDir?: string;
  provider?: (config: EmailConfig) => EmailProvider;
  webhookHttp?: WebhookHttp;
  dnsLookup?: DnsLookup;
  webhookPollInterval?: number;
}

export function templateDirs(
  email: QtiauthConfig['email'],
  configDir: string,
  defaultTemplatesDir: string = DEFAULT_TEMPLATES_DIR,
): string[] {
  return [defaultTemplatesDir, resolve(configDir, email.templates_dir)];
}

export function loadConfiguredTemplates(
  config: Pick<QtiauthConfig, 'branding' | 'email'>,
  configDir: string,
  defaultTemplatesDir?: string,
): Promise<TemplateSet> {
  return loadTemplates({
    definitions: EMAIL_TEMPLATES,
    dirs: templateDirs(config.email, configDir, defaultTemplatesDir),
    defaultLocale: config.email.default_locale,
    brand: brandFromConfig(config.branding),
  });
}

export function notifierService(options: NotifierOptions = {}) {
  return {
    router,
    dataRights: ({ db }) => ({
      exportUser: async (userId) => ({
        email_deliveries: await exportDeliveries(db, userId),
        webhook_deliveries: await exportWebhookDeliveries(db, userId),
      }),
      eraseUser: async (userId, trx) => {
        await eraseDeliveries(trx, userId);
        await eraseWebhookDeliveries(trx, userId);
      },
    }),
    start: async (ctx: Context) => {
      const { config, log, bus, db } = ctx;
      const configDir = options.configDir ?? dirname(ctx.config_path);
      const templates = await loadConfiguredTemplates(
        config,
        configDir,
        options.defaultTemplatesDir,
      );
      const stack: Stoppable[] = [];
      try {
        await seedEndpoints(db, config.webhooks.endpoints, {
          allowPrivate: config.webhooks.allow_private_targets,
          lookup: options.dnsLookup,
        });

        const provider = (options.provider ?? createProvider)(config.email);
        stack.push({ stop: () => provider.close() });

        const metrics = prometheusNotifierMetrics(ctx.metrics);
        const { queue } = config.email;
        const send = createEmailSender({
          templates,
          provider,
          from: config.email.from,
          maxAttempts: queue.max_attempts,
          deliveries: databaseDeliveryLog(db),
          log,
          metrics,
        });
        for (const priority of EMAIL_PRIORITIES) {
          stack.push(
            await consumeWork(bus, {
              queue: emailQueue(priority),
              retry: {
                max_deliver: queue.max_attempts,
                retry_delay: queue.retry_delay,
                max_retry_delay: queue.max_retry_delay,
              },
              metrics: ctx.busMetrics,
              handler: send,
              onError: (error, message) => {
                if (error instanceof EmailSendError) {
                  log.warn('email send failed, will retry', {
                    error,
                    subject: message.subject,
                    attempt: message.attempt,
                  });
                } else {
                  log.error(
                    error instanceof InvalidMessageError
                      ? 'email job rejected'
                      : 'email job failed',
                    { error, subject: message.subject, attempt: message.attempt },
                  );
                }
              },
            }),
          );
        }

        const origins = adminOrigins(config.surfaces);
        const sender = createWebhookSender({
          db,
          http: options.webhookHttp ?? createWebhookHttp({ lookup: options.dnsLookup }),
          config: config.webhooks,
          origins,
          alertEmail: config.branding.support_email,
          locale: config.email.default_locale,
          queueAlert: (request) => queueEmail(bus, request),
          log,
          metrics,
        });

        stack.push(
          await consumeEvents(bus, db, {
            name: 'webhooks',
            types: WEBHOOK_EVENT_TYPES,
            startFrom: 'all',
            catalog: await loadEventCatalog(),
            metrics: ctx.busMetrics,
            handler: async (event, trx) => {
              await enqueueEvent(trx, event, { origins, now: new Date() });
            },
            onError: (error) => {
              log.error('webhook enqueue failed', { error });
            },
          }),
        );

        const poll = () =>
          untraced(async () => {
            await sender.attemptDue();
          }).catch((error: unknown) => {
            log.error('webhook delivery poll failed', { error });
          });
        void poll();
        const timer = setInterval(
          () => void poll(),
          options.webhookPollInterval ?? WEBHOOK_POLL_INTERVAL,
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
              if (attempted > 0) log.info('webhook retries attempted', { attempted });
            },
            onError: (error) => {
              log.error('webhook retry job failed', { error });
            },
          }),
        );

        stack.push(
          await consumeCron(bus, {
            job: RETENTION_JOB,
            metrics: ctx.busMetrics,
            handler: async () => {
              const now = new Date();
              const deliveries = await sweepDeliveries(db, {
                retention: config.retention.delivery_logs,
                now,
              });
              const webhooks = await sweepWebhookDeliveries(db, {
                retention: config.retention.delivery_logs,
                now,
              });
              const pruned = await pruneBusTables(db, config.bus);
              log.info('retention sweep finished', {
                email_deliveries: deliveries,
                webhook_deliveries: webhooks,
                outbox: pruned.outbox,
                processed_events: pruned.processedEvents,
              });
            },
            onError: (error) => {
              log.error('retention sweep failed', { error });
            },
          }),
        );

        log.info('notifier started', {
          provider: provider.name,
          default_locale: templates.defaultLocale,
          templates: templates.templates,
          webhook_endpoints: Object.keys(config.webhooks.endpoints).length,
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
