import { InvalidMessageError, type WorkMessage } from '@qtiauth/bus';
import {
  EMAIL_TEMPLATES,
  type EmailJob,
  emailJobSchema,
  type EmailTemplateDefinition,
} from '@qtiauth/email';
import type { Logger } from '@qtiauth/observability';

import { type DeliveryLog, errorSummary } from './deliveries.ts';
import { type NotifierMetrics, noopNotifierMetrics } from './metrics.ts';
import type { EmailConfig, EmailProvider } from './providers.ts';
import type { TemplateSet } from './templates.ts';

export interface EmailSenderOptions {
  templates: TemplateSet;
  provider: EmailProvider;
  from: EmailConfig['from'];
  maxAttempts: number;
  deliveries: DeliveryLog;
  log: Logger;
  metrics?: NotifierMetrics;
  definitions?: Readonly<Record<string, EmailTemplateDefinition>>;
  now?: () => number;
}

export class EmailSendError extends Error {
  readonly attempt: number;

  constructor(deliveryId: string, attempt: number, cause: unknown) {
    super(`Sending email ${deliveryId} failed on attempt ${String(attempt)}, it will be retried`, {
      cause,
    });
    this.name = 'EmailSendError';
    this.attempt = attempt;
  }
}

function parseJob(
  data: unknown,
  definitions: Readonly<Record<string, EmailTemplateDefinition>>,
): { job: EmailJob; definition: EmailTemplateDefinition; variables: Record<string, unknown> } {
  const parsed = emailJobSchema.safeParse(data);
  if (!parsed.success) {
    throw new InvalidMessageError(
      `Invalid email job: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join(', ')}`,
    );
  }
  const job = parsed.data;
  const definition = definitions[job.template];
  if (!definition) {
    throw new InvalidMessageError(
      `Email job ${job.delivery_id} uses unknown template ${job.template}`,
    );
  }
  const variables = definition.variables.safeParse(job.variables);
  if (!variables.success) {
    throw new InvalidMessageError(
      `Email job ${job.delivery_id} has invalid variables for ${job.template}: ${variables.error.issues.map((issue) => issue.path.join('.')).join(', ')}`,
    );
  }
  return { job, definition, variables: variables.data };
}

export function createEmailSender(
  options: EmailSenderOptions,
): (message: WorkMessage<unknown>) => Promise<void> {
  const metrics = options.metrics ?? noopNotifierMetrics;
  const definitions = options.definitions ?? EMAIL_TEMPLATES;
  const now = options.now ?? Date.now;
  const { provider, deliveries } = options;

  return async (message) => {
    const { job, definition, variables } = parseJob(message.data, definitions);
    const log = options.log.child({
      delivery_id: job.delivery_id,
      template: job.template,
      attempt: message.attempt,
      ...(job.user_id === null ? {} : { user_id: job.user_id }),
    });

    if ((await deliveries.status(job.delivery_id)) === 'sent') {
      log.info('email already sent, skipping');
      return;
    }

    const rendered = options.templates.render(job.template, job.locale, variables);
    const from = options.from[definition.category];
    const record = {
      id: job.delivery_id,
      template: job.template,
      locale: rendered.locale,
      category: definition.category,
      priority: definition.priority,
      recipient: job.to.address,
      user_id: job.user_id,
      attempts: message.attempt,
      provider: provider.name,
      queued_at: new Date(job.queued_at),
    };

    const started = performance.now();
    const seconds = () => (performance.now() - started) / 1000;
    let providerMessageId: string;
    try {
      ({ provider_message_id: providerMessageId } = await provider.send({
        id: job.delivery_id,
        from: { name: from.name, address: from.address },
        to: job.to,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
      }));
    } catch (error) {
      metrics.sendAttempt(provider.name, 'error', seconds());
      const failed = message.attempt >= options.maxAttempts;
      const status = failed ? 'failed' : 'retrying';
      await deliveries.record({
        ...record,
        status,
        provider_message_id: null,
        last_error: errorSummary(error),
        sent_at: null,
      });
      metrics.delivery(provider.name, job.template, status);
      if (failed) {
        log.error('email failed, giving up', { error, max_attempts: options.maxAttempts });
        return;
      }
      throw new EmailSendError(job.delivery_id, message.attempt, error);
    }

    metrics.sendAttempt(provider.name, 'ok', seconds());
    const sentAt = now();
    await deliveries.record({
      ...record,
      status: 'sent',
      provider_message_id: providerMessageId,
      last_error: null,
      sent_at: new Date(sentAt),
    });
    metrics.delivery(provider.name, job.template, 'sent');
    metrics.deliveryDelay(
      definition.priority,
      Math.max(0, sentAt - Date.parse(job.queued_at)) / 1000,
    );
    log.info('email sent', { locale: rendered.locale, provider: provider.name });
  };
}
