import type { NewEvent } from '@qtiauth/bus';
import type { SupportPriority } from '@qtiauth/config';
import { AUDIT_EVENTS, type EventActor, SUPPORT_EVENTS } from '@qtiauth/events';

import type { TicketStatus } from './database.ts';

export interface TicketCreatedData {
  ticket_id: string;
  number: number;
  category: string;
  priority: SupportPriority;
  appeal: boolean;
  guest?: boolean;
  action_id?: string | null;
}

export interface TicketRepliedData {
  ticket_id: string;
  number: number;
  staff: boolean;
}

export interface TicketStatusChangedData {
  ticket_id: string;
  number: number;
  from: TicketStatus;
  to: TicketStatus;
  auto?: boolean;
}

export interface AuditRecordedData {
  action: string;
  target_type: string;
  target_id: string;
}

const SYSTEM_ACTOR: EventActor = { type: 'system', id: 'support' };

export function ticketCreatedEvent(
  ticketId: string,
  data: TicketCreatedData,
  actor: EventActor,
): NewEvent<TicketCreatedData> {
  return {
    type: SUPPORT_EVENTS.ticketCreated,
    actor,
    subject: { type: 'ticket', id: ticketId },
    data,
  };
}

export function ticketRepliedEvent(
  ticketId: string,
  data: TicketRepliedData,
  actor: EventActor,
): NewEvent<TicketRepliedData> {
  return {
    type: SUPPORT_EVENTS.ticketReplied,
    actor,
    subject: { type: 'ticket', id: ticketId },
    data,
  };
}

export function ticketStatusChangedEvent(
  ticketId: string,
  data: TicketStatusChangedData,
  actor: EventActor = SYSTEM_ACTOR,
): NewEvent<TicketStatusChangedData> {
  return {
    type: SUPPORT_EVENTS.ticketStatusChanged,
    actor,
    subject: { type: 'ticket', id: ticketId },
    data,
  };
}

export function auditRecordedEvent(
  actor: EventActor,
  data: AuditRecordedData,
): NewEvent<AuditRecordedData> {
  return {
    type: AUDIT_EVENTS.recorded,
    actor,
    subject: { type: data.target_type, id: data.target_id },
    data,
  };
}
