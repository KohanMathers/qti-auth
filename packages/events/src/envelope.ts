export type ActorType = 'user' | 'service' | 'system';

export interface EventActor {
  type: ActorType;
  id: string;
}

export interface EventSubject {
  type: string;
  id: string;
}

export interface EventEnvelope<Data extends object = Record<string, unknown>> {
  event_id: string;
  type: string;
  occurred_at: string;
  actor: EventActor;
  subject: EventSubject | null;
  data: Data;
  trace_id: string | null;
}
