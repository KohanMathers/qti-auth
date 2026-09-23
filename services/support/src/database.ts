import type { SupportPriority } from '@qtiauth/config';
import type { Generated } from 'kysely';

export const TICKET_STATUSES = ['open', 'pending', 'closed'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export interface TicketsTable {
  id: string;
  number: Generated<number>;
  user_id: string | null;
  category_id: string;
  subject: string;
  status: TicketStatus;
  priority: SupportPriority;
  appeal: boolean;
  action_id: string | null;
  assigned_to: string | null;
  rating: number | null;
  first_response_at: Date | null;
  waiting_since: Date;
  reminder_sent_at: Date | null;
  resolved_at: Date | null;
  created_at: Date;
  updated_at: Generated<Date>;
}

export interface TicketMessagesTable {
  id: string;
  ticket_id: string;
  author_id: string | null;
  staff: boolean;
  body: string;
  created_at: Date;
}

export interface TicketNotesTable {
  id: string;
  ticket_id: string;
  author_id: string;
  body: string;
  created_at: Date;
}

export interface MacrosTable {
  id: string;
  name: string;
  body: string;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

export interface Database {
  tickets: TicketsTable;
  ticket_messages: TicketMessagesTable;
  ticket_notes: TicketNotesTable;
  macros: MacrosTable;
}
