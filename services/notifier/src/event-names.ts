import { WEBHOOK_EVENTS, type WebhookEventName, webhookEventMatches } from '@qtiauth/config';
import { type EventEnvelope, type EventSource, eventType, parseEventType } from '@qtiauth/events';

export const WEBHOOK_EVENT_TYPES = WEBHOOK_EVENTS.map((name) => webhookEventType(name));

export function webhookEventType(name: WebhookEventName): string {
  const dot = name.indexOf('.');
  return eventType(name.slice(0, dot) as EventSource, name.slice(dot + 1), 1);
}

export function webhookEventName(type: string): WebhookEventName | undefined {
  try {
    const parsed = parseEventType(type);
    const name = `${parsed.source}.${parsed.name}`;
    return WEBHOOK_EVENTS.find((event) => event === name);
  } catch {
    return undefined;
  }
}

export function endpointMatches(events: readonly string[], name: string): boolean {
  return events.some((pattern) => webhookEventMatches(pattern, name));
}

export function isDeliverableEvent(event: EventEnvelope): WebhookEventName | undefined {
  return webhookEventName(event.type);
}
