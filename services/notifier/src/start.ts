import { dirname, resolve } from 'node:path';

import { consumeCron, consumeWork, InvalidMessageError, pruneBusTables } from '@qtiauth/bus';
import { type QtiauthConfig, resolveConfigPath } from '@qtiauth/config';
import { EMAIL_PRIORITIES, EMAIL_TEMPLATES, emailQueue } from '@qtiauth/email';
import type { StartServiceOptions, Stoppable } from '@qtiauth/service-kit';

import {
  type Database,
  databaseDeliveryLog,
  eraseDeliveries,
  exportDeliveries,
  sweepDeliveries,
} from './deliveries.ts';
import { prometheusNotifierMetrics } from './metrics.ts';
import { createProvider, type EmailConfig, type EmailProvider } from './providers.ts';
import { createEmailSender, EmailSendError } from './sender.ts';
import { type Context, type definition, router } from './service.ts';
import {
  brandFromConfig,
  DEFAULT_TEMPLATES_DIR,
  loadTemplates,
  type TemplateSet,
} from './templates.ts';

export const RETENTION_JOB = 'retention.sweep';

export interface NotifierOptions {
  configDir?: string;
  defaultTemplatesDir?: string;
  provider?: (config: EmailConfig) => EmailProvider;
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
  const configDir = options.configDir ?? dirname(resolveConfigPath(process.env));
  return {
    router,
    dataRights: ({ db }) => ({
      exportUser: async (userId) => ({ email_deliveries: await exportDeliveries(db, userId) }),
      eraseUser: async (userId, trx) => {
        await eraseDeliveries(trx, userId);
      },
    }),
    start: async (ctx: Context) => {
      const { config, log, bus, db } = ctx;
      const templates = await loadConfiguredTemplates(
        config,
        configDir,
        options.defaultTemplatesDir,
      );
      const stack: Stoppable[] = [];
      try {
        const provider = (options.provider ?? createProvider)(config.email);
        stack.push({ stop: () => provider.close() });

        const { queue } = config.email;
        const send = createEmailSender({
          templates,
          provider,
          from: config.email.from,
          maxAttempts: queue.max_attempts,
          deliveries: databaseDeliveryLog(db),
          log,
          metrics: prometheusNotifierMetrics(ctx.metrics),
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

        stack.push(
          await consumeCron(bus, {
            job: RETENTION_JOB,
            metrics: ctx.busMetrics,
            handler: async () => {
              const deliveries = await sweepDeliveries(db, config.retention.delivery_logs);
              const pruned = await pruneBusTables(db, config.bus);
              log.info('retention sweep finished', {
                email_deliveries: deliveries,
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
        });
        return stack;
      } catch (error) {
        for (const task of stack.reverse()) await task.stop();
        throw error;
      }
    },
  } satisfies StartServiceOptions<typeof definition, Database>;
}
