import type { WebhookFormat } from '@qtiauth/config';
import type { EmailCategory, EmailPriority } from '@qtiauth/email';
import type { Generated } from 'kysely';

import type { WebhookPayload } from './payload.ts';

export const DELIVERY_STATUSES = ['retrying', 'sent', 'failed'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const WEBHOOK_TRIGGERS = ['event', 'test', 'replay'] as const;
export type WebhookTrigger = (typeof WEBHOOK_TRIGGERS)[number];

export interface EmailDeliveriesTable {
  id: string;
  template: string;
  locale: string;
  category: EmailCategory;
  priority: EmailPriority;
  recipient: string;
  user_id: string | null;
  status: DeliveryStatus;
  attempts: number;
  provider: string;
  provider_message_id: string | null;
  last_error: string | null;
  queued_at: Date;
  sent_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface WebhookEndpointsTable {
  id: string;
  slug: string | null;
  url: string;
  description: string;
  events: string[];
  format: WebhookFormat;
  secret: string;
  previous_secret: string | null;
  previous_secret_expires_at: Date | null;
  enabled: boolean;
  consecutive_failures: number;
  disabled_reason: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface WebhookDeliveriesTable {
  id: string;
  endpoint_id: string;
  event_id: string;
  event_type: string;
  trigger: WebhookTrigger;
  replay_of: string | null;
  subject_type: string | null;
  subject_id: string | null;
  payload: WebhookPayload;
  status: DeliveryStatus;
  attempts: number;
  next_attempt_at: Date | null;
  queued_at: Date;
  sent_at: Date | null;
  last_error: string | null;
  request_url: string | null;
  request_headers: Record<string, string> | null;
  request_body: string | null;
  response_status: number | null;
  response_headers: Record<string, string> | null;
  response_body: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface Database {
  email_deliveries: EmailDeliveriesTable;
  webhook_endpoints: WebhookEndpointsTable;
  webhook_deliveries: WebhookDeliveriesTable;
}
