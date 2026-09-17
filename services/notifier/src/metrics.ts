import type { EmailPriority } from '@qtiauth/email';
import type { Metrics } from '@qtiauth/observability';

import type { DeliveryStatus } from './deliveries.ts';

export type SendOutcome = 'ok' | 'error';

export interface NotifierMetrics {
  sendAttempt: (provider: string, outcome: SendOutcome, seconds: number) => void;
  delivery: (provider: string, template: string, status: DeliveryStatus) => void;
  deliveryDelay: (priority: EmailPriority, seconds: number) => void;
}

const ignore = (): void => undefined;

export const noopNotifierMetrics: NotifierMetrics = {
  sendAttempt: ignore,
  delivery: ignore,
  deliveryDelay: ignore,
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
  };
}
