export const EVENT_SOURCES = [
  'identity',
  'notifier',
  'oidc',
  'safety',
  'support',
  'games',
  'audit',
] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

export interface EventType {
  source: EventSource;
  name: string;
  version: number;
}

const EVENT_TYPE =
  /^qtiauth\.([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*)\.v([1-9]\d*)$/;

export class EventTypeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventTypeError';
  }
}

export function parseEventType(type: string): EventType {
  const match = EVENT_TYPE.exec(type);
  if (!match) {
    throw new EventTypeError(
      `Event type ${type} must look like qtiauth.<service>.<entity>.<verb>.v<n>`,
    );
  }
  const [, source = '', name = '', version = ''] = match;
  if (!(EVENT_SOURCES as readonly string[]).includes(source)) {
    throw new EventTypeError(
      `Event type ${type} has unknown source ${source}. Known sources: ${EVENT_SOURCES.join(', ')}`,
    );
  }
  return { source: source as EventSource, name, version: Number(version) };
}

export function eventType(source: EventSource, name: string, version: number): string {
  const type = `qtiauth.${source}.${name}.v${String(version)}`;
  parseEventType(type);
  return type;
}
