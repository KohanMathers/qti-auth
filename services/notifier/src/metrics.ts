import type { EmailPriority } from '@qtiauth/email';
import type { Metrics } from '@qtiauth/observability';

import type { DeliveryStatus } from './deliveries.ts';

export type SendOutcome = 'ok' | 'error';

export interface NotifierMetrics {
  sendAttempt: (provider: string, outcome: SendOutcome, seconds: number) => void;
  delivery: (provider: string, template: string, status: DeliveryStatus) => void;
  deliveryDelay: (priority: EmailPriority, seconds: number) => void;
  webhookAttempt: (format: string, outcome: SendOutcome, seconds: number) => void;
  webhookDelivery: (format: string, status: DeliveryStatus) => void;
  webhookDeliveryDelay: (format: string, seconds: number) => void;
  webhookDisabled: (format: string) => void;
}

const ignore = (): void => undefined;

export const noopNotifierMetrics: NotifierMetrics = {
  sendAttempt: ignore,
  delivery: ignore,
  deliveryDelay: ignore,
  webhookAttempt: ignore,
  webhookDelivery: ignore,
  webhookDeliveryDelay: ignore,
  webhookDisabled: ignore,
};

export function prometheusNotifierMetrics(metrics: Metrics): NotifierMetrics {
  const emails = metrics.counter({
    name: 'qtiauth_email_deliveries_total',
    help: 'Email send attempts, by provider, template and resulting status: sent, retrying or failed.',
    labelNames: ['provider', 'template', 'status'],
  });
  const sendDuration = metrics.histogram({
    name: 'qtiauth_email_send_duration_seconds',
    help: 'How long the provider takes to accept or refuse an email, by provider and outcome.',
    labelNames: ['provider', 'outcome'],
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
  });
  const delay = metrics.histogram({
    name: 'qtiauth_email_delivery_delay_seconds',
    help: 'Time from queueing an email to the provider accepting it, by priority.',
    labelNames: ['priority'],
    buckets: [0.1, 0.5, 1, 5, 10, 30, 60, 300, 900, 1800, 3600, 21600],
  });
  const webhooks = metrics.counter({
    name: 'qtiauth_webhook_deliveries_total',
    help: 'Webhook send attempts, by endpoint format and resulting status: sent, retrying or failed.',
    labelNames: ['format', 'status'],
  });
  const webhookDuration = metrics.histogram({
    name: 'qtiauth_webhook_delivery_duration_seconds',
    help: 'How long a webhook POST takes, by format and outcome.',
    labelNames: ['format', 'outcome'],
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
  });
  const webhookDelay = metrics.histogram({
    name: 'qtiauth_webhook_delivery_delay_seconds',
    help: 'Time from queueing a webhook to the destination accepting it, by format.',
    labelNames: ['format'],
    buckets: [0.1, 0.5, 1, 5, 10, 30, 60, 300, 900, 1800, 3600, 21600, 86400],
  });
  const disabled = metrics.counter({
    name: 'qtiauth_webhook_endpoints_disabled_total',
    help: 'Webhook endpoints auto-disabled after consecutive failures, by format.',
    labelNames: ['format'],
  });

  return {
    sendAttempt: (provider, outcome, seconds) => {
      sendDuration.observe({ provider, outcome }, seconds);
    },
    delivery: (provider, template, status) => {
      emails.inc({ provider, template, status });
    },
    deliveryDelay: (priority, seconds) => {
      delay.observe({ priority }, seconds);
    },
    webhookAttempt: (format, outcome, seconds) => {
      webhookDuration.observe({ format, outcome }, seconds);
    },
    webhookDelivery: (format, status) => {
      webhooks.inc({ format, status });
    },
    webhookDeliveryDelay: (format, seconds) => {
      webhookDelay.observe({ format }, seconds);
    },
    webhookDisabled: (format) => {
      disabled.inc({ format });
    },
  };
}
