import type { SupportPriority } from '@qtiauth/config';
import type { Generated } from 'kysely';

export const TICKET_STATUSES = ['open', 'pending', 'closed'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const KB_STATUSES = ['draft', 'published'] as const;
export type KbStatus = (typeof KB_STATUSES)[number];

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
  guest_email: string | null;
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

export interface GuestCodesTable {
  id: string;
  email: string;
  email_normalized: string;
  code_hash: string;
  created_at: Date;
  expires_at: Date;
  used_at: Date | null;
}

export interface GuestLinksTable {
  id: string;
  ticket_id: string;
  token_hash: string;
  created_at: Date;
  expires_at: Date;
}

export interface GuestAttemptsTable {
  ip: string;
  attempts: number;
  updated_at: Date;
}

export interface TicketAttachmentsTable {
  id: string;
  ticket_id: string;
  object_key: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  created_at: Date;
}

export interface KbCategoriesTable {
  id: string;
  slug: string;
  name: string;
  icon: string | null;
  display_order: number;
  created_at: Date;
  updated_at: Date;
}

export interface KbArticlesTable {
  id: string;
  category_id: string;
  slug: string;
  title: string;
  body: string;
  status: KbStatus;
  tags: string[];
  published_at: Date | null;
  created_by: string;
  updated_by: string;
  created_at: Date;
  updated_at: Date;
}

export interface KbRevisionsTable {
  id: string;
  article_id: string;
  revision: number;
  title: string;
  body: string;
  tags: string[];
  slug: string;
  category_id: string;
  status: KbStatus;
  author_id: string;
  created_at: Date;
}

export interface KbImagesTable {
  id: string;
  object_key: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  created_by: string;
  created_at: Date;
}

export interface KbFeedbackTable {
  article_id: string;
  session_id: string;
  helpful: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface Database {
  tickets: TicketsTable;
  ticket_messages: TicketMessagesTable;
  ticket_notes: TicketNotesTable;
  macros: MacrosTable;
  guest_codes: GuestCodesTable;
  guest_links: GuestLinksTable;
  guest_attempts: GuestAttemptsTable;
  ticket_attachments: TicketAttachmentsTable;
  kb_categories: KbCategoriesTable;
  kb_articles: KbArticlesTable;
  kb_revisions: KbRevisionsTable;
  kb_images: KbImagesTable;
  kb_feedback: KbFeedbackTable;
}
