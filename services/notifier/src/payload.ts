import type { WebhookEventName } from '@qtiauth/config';
import type { EventEnvelope, EventSubject } from '@qtiauth/events';

const ALLOWED_DATA = new Set([
  'account_state',
  'action',
  'age_band',
  'appeal',
  'auto',
  'category',
  'format',
  'held',
  'number',
  'priority',
  'reason',
  'signup_method',
  'status',
  'trust',
  'type',
  'outcome',
  'restrictions',
]);

const DENIED_DATA = /^(content|snapshot|description|reporter|body|text|message|evidence|email|ip)/i;

export interface WebhookPayload {
  event_id: string;
  type: string;
  occurred_at: string;
  subject: EventSubject | null;
  data: Record<string, unknown>;
  admin_url: string | null;
}

export function minimizeData(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (DENIED_DATA.test(key)) continue;
    if (ALLOWED_DATA.has(key) || key === 'id' || key.endsWith('_id')) out[key] = value;
  }
  return out;
}

export function adminPath(type: string, subject: EventSubject | null): string {
  if (subject === null) return '/admin/webhooks';
  if (type.startsWith('identity.user.')) return `/admin/users/${subject.id}`;
  if (type.startsWith('safety.report.')) return `/admin/safety/reports/${subject.id}`;
  if (type.startsWith('safety.appeal.')) return `/admin/safety/appeals/${subject.id}`;
  if (type.startsWith('support.ticket.')) return `/admin/support/tickets/${subject.id}`;
  if (type.startsWith('games.entitlement.')) return `/admin/games/entitlements/${subject.id}`;
  if (type.startsWith('oidc.client.')) return `/admin/oidc/clients/${subject.id}`;
  return '/admin/webhooks';
}

export function webhookPayload(
  event: Pick<EventEnvelope, 'event_id' | 'occurred_at' | 'subject' | 'data'>,
  type: WebhookEventName | 'webhook.test',
  origin: string | undefined,
): WebhookPayload {
  const path = adminPath(type, event.subject);
  return {
    event_id: event.event_id,
    type,
    occurred_at: event.occurred_at,
    subject: event.subject,
    data: minimizeData(event.data),
    admin_url: origin === undefined ? null : new URL(path, origin).toString(),
  };
}

function titleOf(type: string): string {
  const verb = type.split('.').at(-1) ?? type;
  return verb.replaceAll('_', ' ');
}

function fieldLines(payload: WebhookPayload): { name: string; value: string }[] {
  const fields = [
    ...(payload.subject === null
      ? []
      : [{ name: 'Subject', value: `${payload.subject.type} ${payload.subject.id}` }]),
    ...Object.entries(payload.data).map(([name, value]) => ({
      name,
      value: String(value),
    })),
  ];
  return fields.map((field) => ({
    name: field.name.slice(0, 256),
    value: field.value.slice(0, 1024) || '-',
  }));
}

export function discordBody(payload: WebhookPayload): string {
  const fields = fieldLines(payload).map((field) => ({ ...field, inline: true }));
  return JSON.stringify({
    embeds: [
      {
        title: `${payload.type}: ${titleOf(payload.type)}`,
        url: payload.admin_url ?? undefined,
        timestamp: payload.occurred_at,
        fields,
      },
    ],
  });
}

export function slackBody(payload: WebhookPayload): string {
  const lines = [
    `*${payload.type}*`,
    ...fieldLines(payload).map((field) => `*${field.name}:* ${field.value}`),
  ];
  const blocks: Record<string, unknown>[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: titleOf(payload.type).slice(0, 150), emoji: true },
    },
    { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n').slice(0, 3000) } },
  ];
  if (payload.admin_url !== null) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Open' },
          url: payload.admin_url,
        },
      ],
    });
  }
  return JSON.stringify({ text: payload.type, blocks });
}

export function standardBody(payload: WebhookPayload): string {
  return JSON.stringify(payload);
}
