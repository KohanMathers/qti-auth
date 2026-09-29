import { randomUUID } from 'node:crypto';

import { writeEvent } from '@qtiauth/bus';
import type { SupportPriority } from '@qtiauth/config';
import type { EventActor } from '@qtiauth/events';
import { attachmentObjectPrefix, type ObjectStore } from '@qtiauth/service-kit';
import type { Kysely, Transaction } from 'kysely';

import { appealCategory, type TicketCategory } from './categories.ts';
import type { Database, TicketStatus } from './database.ts';
import {
  type AuditRecordedData,
  auditRecordedEvent,
  ticketCreatedEvent,
  type TicketCreatedData,
  ticketRepliedEvent,
  type TicketRepliedData,
  ticketStatusChangedEvent,
  type TicketStatusChangedData,
} from './events.ts';

export const CREATE_APPEAL_METHOD = 'create_appeal';
export const USER_TICKETS_METHOD = 'user_tickets';
export const USER_TICKET_LIMIT = 50;

export interface TicketRecord {
  id: string;
  number: number;
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
  updated_at: Date;
}

export interface TicketMessage {
  id: string;
  ticket_id: string;
  author_id: string | null;
  staff: boolean;
  body: string;
  created_at: Date;
}

export interface TicketNote {
  id: string;
  ticket_id: string;
  author_id: string;
  body: string;
  created_at: Date;
}

export type CreateTicketResult =
  | { status: 'ok'; ticket: TicketRecord }
  | { status: 'unknown_category' }
  | { status: 'appeal_category' }
  | { status: 'too_long' };

export type CreateAppealResult =
  | { status: 'ok'; ticket: TicketRecord }
  | { status: 'unknown_category' }
  | { status: 'exists'; ticket: TicketRecord }
  | { status: 'too_long' };

export type CloseResult =
  { status: 'ok'; ticket: TicketRecord } | { status: 'not_found' } | { status: 'closed' };

export type ReopenResult =
  { status: 'ok'; ticket: TicketRecord } | { status: 'not_found' } | { status: 'open' };

export type RateResult =
  | { status: 'ok'; ticket: TicketRecord }
  | { status: 'not_found' }
  | { status: 'open' }
  | { status: 'rated' };

export type NoteResult =
  { status: 'ok'; ticket: TicketRecord } | { status: 'not_found' } | { status: 'too_long' };

export type UpdateResult =
  | { status: 'ok'; ticket: TicketRecord }
  | { status: 'not_found' }
  | { status: 'unknown_category' }
  | { status: 'appeal_category' };

async function writeAudit(
  trx: Kysely<Database>,
  actor: EventActor,
  action: string,
  ticketId: string,
): Promise<void> {
  await writeEvent<Database, AuditRecordedData>(
    trx,
    auditRecordedEvent(actor, { action, target_type: 'ticket', target_id: ticketId }),
  );
}

export async function getTicket(
  db: Kysely<Database>,
  id: string,
): Promise<TicketRecord | undefined> {
  return db.selectFrom('tickets').selectAll().where('id', '=', id).executeTakeFirst();
}

export async function listUserTickets(
  db: Kysely<Database>,
  options: { userId: string; after?: { created_at: string; id: string }; limit: number },
): Promise<TicketRecord[]> {
  let query = db.selectFrom('tickets').selectAll().where('user_id', '=', options.userId);
  if (options.after !== undefined) {
    const createdAt = new Date(options.after.created_at);
    const afterId = options.after.id;
    query = query.where((eb) =>
      eb.or([
        eb('created_at', '<', createdAt),
        eb.and([eb('created_at', '=', createdAt), eb('id', '<', afterId)]),
      ]),
    );
  }
  return query.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(options.limit).execute();
}

export async function listQueue(
  db: Kysely<Database>,
  options: {
    status?: TicketStatus;
    category?: string;
    assignedTo?: string | null;
    priority?: SupportPriority;
    after?: { created_at: string; id: string };
    limit: number;
  },
): Promise<TicketRecord[]> {
  let query = db.selectFrom('tickets').selectAll();
  if (options.status !== undefined) query = query.where('status', '=', options.status);
  if (options.category !== undefined) query = query.where('category_id', '=', options.category);
  if (options.priority !== undefined) query = query.where('priority', '=', options.priority);
  if (options.assignedTo === null) query = query.where('assigned_to', 'is', null);
  else if (options.assignedTo !== undefined) {
    query = query.where('assigned_to', '=', options.assignedTo);
  }
  if (options.after !== undefined) {
    const createdAt = new Date(options.after.created_at);
    const afterId = options.after.id;
    query = query.where((eb) =>
      eb.or([
        eb('created_at', '<', createdAt),
        eb.and([eb('created_at', '=', createdAt), eb('id', '<', afterId)]),
      ]),
    );
  }
  return query.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(options.limit).execute();
}

export async function listTicketMessages(
  db: Kysely<Database>,
  ticketId: string,
): Promise<TicketMessage[]> {
  return db
    .selectFrom('ticket_messages')
    .selectAll()
    .where('ticket_id', '=', ticketId)
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc')
    .execute();
}

export async function listTicketNotes(
  db: Kysely<Database>,
  ticketId: string,
): Promise<TicketNote[]> {
  return db
    .selectFrom('ticket_notes')
    .selectAll()
    .where('ticket_id', '=', ticketId)
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc')
    .execute();
}

export async function userTickets(
  db: Kysely<Database>,
  userId: string,
): Promise<{ items: TicketRecord[] }> {
  const items = await db
    .selectFrom('tickets')
    .selectAll()
    .where('user_id', '=', userId)
    .orderBy('created_at', 'desc')
    .limit(USER_TICKET_LIMIT)
    .execute();
  return { items };
}

export async function insertTicket(
  trx: Transaction<Database>,
  values: {
    id: string;
    userId: string | null;
    guestEmail: string | null;
    categoryId: string;
    subject: string;
    status: TicketStatus;
    priority: SupportPriority;
    appeal: boolean;
    actionId: string | null;
    body: string;
    actor: EventActor;
    now: Date;
  },
): Promise<TicketRecord> {
  const ticket = await trx
    .insertInto('tickets')
    .values({
      id: values.id,
      user_id: values.userId,
      guest_email: values.guestEmail,
      category_id: values.categoryId,
      subject: values.subject,
      status: values.status,
      priority: values.priority,
      appeal: values.appeal,
      action_id: values.actionId,
      assigned_to: null,
      rating: null,
      first_response_at: null,
      waiting_since: values.now,
      reminder_sent_at: null,
      resolved_at: null,
      created_at: values.now,
      updated_at: values.now,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await trx
    .insertInto('ticket_messages')
    .values({
      id: randomUUID(),
      ticket_id: ticket.id,
      author_id: values.userId,
      staff: false,
      body: values.body,
      created_at: values.now,
    })
    .execute();
  await writeEvent<Database, TicketCreatedData>(
    trx,
    ticketCreatedEvent(
      ticket.id,
      {
        ticket_id: ticket.id,
        number: ticket.number,
        category: ticket.category_id,
        priority: ticket.priority,
        appeal: ticket.appeal,
        guest: values.guestEmail !== null,
        action_id: ticket.action_id,
      },
      values.actor,
    ),
  );
  return ticket;
}

export async function createTicket(
  db: Kysely<Database>,
  options: {
    userId: string;
    categoryId: string;
    subject: string;
    body: string;
    categories: Map<string, TicketCategory>;
    maxSubject: number;
    maxBody: number;
    now: Date;
  },
): Promise<CreateTicketResult> {
  if (options.subject.length > options.maxSubject || options.body.length > options.maxBody) {
    return { status: 'too_long' };
  }
  const category = options.categories.get(options.categoryId);
  if (!category) return { status: 'unknown_category' };
  if (category.appeal) return { status: 'appeal_category' };
  const actor: EventActor = { type: 'user', id: options.userId };
  const ticket = await db.transaction().execute(async (trx) =>
    insertTicket(trx, {
      id: randomUUID(),
      userId: options.userId,
      guestEmail: null,
      categoryId: category.id,
      subject: options.subject.trim(),
      status: 'open',
      priority: 'normal',
      appeal: false,
      actionId: null,
      body: options.body,
      actor,
      now: options.now,
    }),
  );
  return { status: 'ok', ticket };
}

async function openAppealFor(
  db: Kysely<Database>,
  userId: string,
  actionId: string | null,
): Promise<TicketRecord | undefined> {
  let query = db
    .selectFrom('tickets')
    .selectAll()
    .where('user_id', '=', userId)
    .where('appeal', '=', true)
    .where('status', '<>', 'closed');
  query =
    actionId === null
      ? query.where('action_id', 'is', null)
      : query.where('action_id', '=', actionId);
  return query.executeTakeFirst();
}

export async function createAppealTicket(
  db: Kysely<Database>,
  options: {
    userId: string;
    actionId: string | null;
    body: string;
    categories: Map<string, TicketCategory>;
    maxBody: number;
    now: Date;
  },
): Promise<CreateAppealResult> {
  if (options.body.length > options.maxBody) return { status: 'too_long' };
  const category = appealCategory(options.categories);
  if (!category) return { status: 'unknown_category' };
  const existing = await openAppealFor(db, options.userId, options.actionId);
  if (existing) return { status: 'exists', ticket: existing };
  const actor: EventActor = { type: 'user', id: options.userId };
  const ticket = await db.transaction().execute(async (trx) =>
    insertTicket(trx, {
      id: randomUUID(),
      userId: options.userId,
      guestEmail: null,
      categoryId: category.id,
      subject: category.name,
      status: 'open',
      priority: 'high',
      appeal: true,
      actionId: options.actionId,
      body: options.body,
      actor,
      now: options.now,
    }),
  );
  return { status: 'ok', ticket };
}

export type ReplyResult =
  | { status: 'ok'; ticket: TicketRecord; firstResponseSeconds: number | null }
  | { status: 'not_found' }
  | { status: 'closed' }
  | { status: 'too_long' };

export async function replyToTicket(
  db: Kysely<Database>,
  options: {
    ticketId: string;
    authorId: string | null;
    staff: boolean;
    body: string;
    maxBody: number;
    now: Date;
  },
): Promise<ReplyResult> {
  if (options.body.length > options.maxBody) return { status: 'too_long' };
  const ticket = await getTicket(db, options.ticketId);
  if (!ticket) return { status: 'not_found' };
  if (ticket.status === 'closed') return { status: 'closed' };
  const nextStatus: TicketStatus = options.staff ? 'pending' : 'open';
  const actor: EventActor =
    options.authorId === null
      ? { type: 'system', id: 'guest' }
      : { type: 'user', id: options.authorId };
  const result = await db.transaction().execute(async (trx) => {
    const firstResponse =
      options.staff && ticket.first_response_at === null ? options.now : ticket.first_response_at;
    const updated = await trx
      .updateTable('tickets')
      .set({
        status: nextStatus,
        first_response_at: firstResponse,
        waiting_since: options.now,
        reminder_sent_at: options.staff ? ticket.reminder_sent_at : null,
        updated_at: options.now,
      })
      .where('id', '=', ticket.id)
      .where('status', '<>', 'closed')
      .returningAll()
      .executeTakeFirst();
    if (!updated) return null;
    await trx
      .insertInto('ticket_messages')
      .values({
        id: randomUUID(),
        ticket_id: ticket.id,
        author_id: options.authorId,
        staff: options.staff,
        body: options.body,
        created_at: options.now,
      })
      .execute();
    await writeEvent<Database, TicketRepliedData>(
      trx,
      ticketRepliedEvent(
        ticket.id,
        { ticket_id: ticket.id, number: ticket.number, staff: options.staff },
        actor,
      ),
    );
    if (updated.status !== ticket.status) {
      await writeEvent<Database, TicketStatusChangedData>(
        trx,
        ticketStatusChangedEvent(
          ticket.id,
          {
            ticket_id: ticket.id,
            number: ticket.number,
            from: ticket.status,
            to: updated.status,
          },
          actor,
        ),
      );
    }
    if (options.staff) await writeAudit(trx, actor, 'support.ticket.replied', ticket.id);
    return updated;
  });
  if (!result) return { status: 'closed' };
  const firstResponseSeconds =
    options.staff && ticket.first_response_at === null
      ? (options.now.getTime() - ticket.created_at.getTime()) / 1000
      : null;
  return { status: 'ok', ticket: result, firstResponseSeconds };
}

type SetStatusResult =
  { status: 'ok'; ticket: TicketRecord } | { status: 'not_found' } | { status: 'unchanged' };

async function setStatus(
  db: Kysely<Database>,
  options: {
    ticketId: string;
    to: TicketStatus;
    actor: EventActor;
    now: Date;
    auto?: boolean;
    audit?: string;
  },
): Promise<SetStatusResult> {
  const ticket = await getTicket(db, options.ticketId);
  if (!ticket) return { status: 'not_found' };
  if (options.to === 'closed' && ticket.status === 'closed') return { status: 'unchanged' };
  if (options.to !== 'closed' && ticket.status !== 'closed') return { status: 'unchanged' };
  const updated = await db.transaction().execute(async (trx) => {
    const row = await trx
      .updateTable('tickets')
      .set({
        status: options.to,
        waiting_since: options.now,
        reminder_sent_at: null,
        resolved_at: options.to === 'closed' ? options.now : null,
        rating: options.to === 'closed' ? ticket.rating : null,
        updated_at: options.now,
      })
      .where('id', '=', ticket.id)
      .where('status', '=', ticket.status)
      .returningAll()
      .executeTakeFirst();
    if (!row) return null;
    await writeEvent<Database, TicketStatusChangedData>(
      trx,
      ticketStatusChangedEvent(
        ticket.id,
        {
          ticket_id: ticket.id,
          number: ticket.number,
          from: ticket.status,
          to: options.to,
          ...(options.auto === true ? { auto: true } : {}),
        },
        options.actor,
      ),
    );
    if (options.audit !== undefined) await writeAudit(trx, options.actor, options.audit, ticket.id);
    return row;
  });
  if (!updated) return { status: 'unchanged' };
  return { status: 'ok', ticket: updated };
}

export async function closeTicket(
  db: Kysely<Database>,
  options: { ticketId: string; actor: EventActor; now: Date; auto?: boolean; staff?: boolean },
): Promise<CloseResult> {
  const result = await setStatus(db, {
    ticketId: options.ticketId,
    to: 'closed',
    actor: options.actor,
    now: options.now,
    ...(options.auto === true ? { auto: true } : {}),
    ...(options.staff === true ? { audit: 'support.ticket.closed' } : {}),
  });
  if (result.status === 'unchanged') return { status: 'closed' };
  return result;
}

export async function reopenTicket(
  db: Kysely<Database>,
  options: { ticketId: string; actor: EventActor; now: Date; staff?: boolean },
): Promise<ReopenResult> {
  const result = await setStatus(db, {
    ticketId: options.ticketId,
    to: 'open',
    actor: options.actor,
    now: options.now,
    ...(options.staff === true ? { audit: 'support.ticket.reopened' } : {}),
  });
  if (result.status === 'unchanged') return { status: 'open' };
  return result;
}

export async function rateTicket(
  db: Kysely<Database>,
  options: { ticketId: string; userId: string | null; rating: number; now: Date; guest?: boolean },
): Promise<RateResult> {
  const ticket = await getTicket(db, options.ticketId);
  if (!ticket) return { status: 'not_found' };
  if (options.guest === true) {
    if (ticket.guest_email === null) return { status: 'not_found' };
  } else if (ticket.user_id !== options.userId) return { status: 'not_found' };
  if (ticket.status !== 'closed') return { status: 'open' };
  if (ticket.rating !== null) return { status: 'rated' };
  const updated = await db
    .updateTable('tickets')
    .set({ rating: options.rating, updated_at: options.now })
    .where('id', '=', ticket.id)
    .where('status', '=', 'closed')
    .where('rating', 'is', null)
    .returningAll()
    .executeTakeFirst();
  if (!updated) return { status: 'rated' };
  return { status: 'ok', ticket: updated };
}

export async function addNote(
  db: Kysely<Database>,
  options: { ticketId: string; authorId: string; body: string; maxBody: number; now: Date },
): Promise<NoteResult> {
  if (options.body.length > options.maxBody) return { status: 'too_long' };
  const ticket = await getTicket(db, options.ticketId);
  if (!ticket) return { status: 'not_found' };
  const actor: EventActor = { type: 'user', id: options.authorId };
  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto('ticket_notes')
      .values({
        id: randomUUID(),
        ticket_id: ticket.id,
        author_id: options.authorId,
        body: options.body,
        created_at: options.now,
      })
      .execute();
    await writeAudit(trx, actor, 'support.ticket.noted', ticket.id);
  });
  return { status: 'ok', ticket };
}

export async function updateTicket(
  db: Kysely<Database>,
  options: {
    ticketId: string;
    actorId: string;
    assignedTo?: string | null;
    priority?: SupportPriority;
    categoryId?: string;
    categories: Map<string, TicketCategory>;
    now: Date;
  },
): Promise<UpdateResult> {
  const ticket = await getTicket(db, options.ticketId);
  if (!ticket) return { status: 'not_found' };
  if (options.categoryId !== undefined) {
    const category = options.categories.get(options.categoryId);
    if (!category) return { status: 'unknown_category' };
    if (category.appeal !== ticket.appeal) return { status: 'appeal_category' };
  }
  const actor: EventActor = { type: 'user', id: options.actorId };
  const updated = await db.transaction().execute(async (trx) => {
    const row = await trx
      .updateTable('tickets')
      .set({
        ...(options.assignedTo !== undefined ? { assigned_to: options.assignedTo } : {}),
        ...(options.priority !== undefined ? { priority: options.priority } : {}),
        ...(options.categoryId !== undefined ? { category_id: options.categoryId } : {}),
        updated_at: options.now,
      })
      .where('id', '=', ticket.id)
      .returningAll()
      .executeTakeFirst();
    if (!row) return null;
    await writeAudit(trx, actor, 'support.ticket.updated', ticket.id);
    return row;
  });
  if (!updated) return { status: 'not_found' };
  return { status: 'ok', ticket: updated };
}

export interface AutoCloseResult {
  reminded: TicketRecord[];
  closed: TicketRecord[];
}

export async function sweepAutoClose(
  db: Kysely<Database>,
  options: { autoCloseAfter: number; now: Date },
): Promise<AutoCloseResult> {
  const pending = await db
    .selectFrom('tickets')
    .selectAll()
    .where('status', '=', 'pending')
    .execute();
  const reminded: TicketRecord[] = [];
  const closed: TicketRecord[] = [];
  const half = options.autoCloseAfter / 2;
  const actor: EventActor = { type: 'system', id: 'support' };
  for (const ticket of pending) {
    const waited = options.now.getTime() - ticket.waiting_since.getTime();
    if (waited >= options.autoCloseAfter) {
      const result = await closeTicket(db, {
        ticketId: ticket.id,
        actor,
        now: options.now,
        auto: true,
      });
      if (result.status === 'ok') closed.push(result.ticket);
      continue;
    }
    if (waited >= half && ticket.reminder_sent_at === null) {
      const updated = await db
        .updateTable('tickets')
        .set({ reminder_sent_at: options.now, updated_at: options.now })
        .where('id', '=', ticket.id)
        .where('status', '=', 'pending')
        .where('reminder_sent_at', 'is', null)
        .returningAll()
        .executeTakeFirst();
      if (updated) reminded.push(updated);
    }
  }
  return { reminded, closed };
}

export async function countOpenByStatusAndCategory(
  db: Kysely<Database>,
): Promise<{ status: TicketStatus; category_id: string; count: number }[]> {
  const rows = await db
    .selectFrom('tickets')
    .select(['status', 'category_id'])
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('status', '<>', 'closed')
    .groupBy(['status', 'category_id'])
    .execute();
  return rows.map((row) => ({
    status: row.status,
    category_id: row.category_id,
    count: Number(row.count),
  }));
}

export interface StaffMetrics {
  first_response_seconds: { count: number; average: number | null };
  resolution_seconds: { count: number; average: number | null };
  csat: { rating: number; count: number }[];
  by_category: { category_id: string; open: number; pending: number; closed: number }[];
  by_agent: { agent_id: string; closed: number }[];
  guest_tickets: number;
}

export async function staffMetricsSnapshot(
  db: Kysely<Database>,
  options: { since: Date },
): Promise<StaffMetrics> {
  const recent = await db
    .selectFrom('tickets')
    .selectAll()
    .where('created_at', '>=', options.since)
    .execute();
  const withResponse = recent.filter((ticket) => ticket.first_response_at !== null);
  const resolved = recent.filter((ticket) => ticket.resolved_at !== null);
  const rated = recent.filter((ticket) => ticket.rating !== null);
  const average = (values: number[]) =>
    values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
  const csat = [1, 2, 3, 4, 5].map((rating) => ({
    rating,
    count: rated.filter((ticket) => ticket.rating === rating).length,
  }));
  const categories = new Map<string, { open: number; pending: number; closed: number }>();
  for (const ticket of recent) {
    const current = categories.get(ticket.category_id) ?? { open: 0, pending: 0, closed: 0 };
    current[ticket.status] += 1;
    categories.set(ticket.category_id, current);
  }
  const agents = new Map<string, number>();
  for (const ticket of resolved) {
    if (ticket.assigned_to === null) continue;
    agents.set(ticket.assigned_to, (agents.get(ticket.assigned_to) ?? 0) + 1);
  }
  return {
    first_response_seconds: {
      count: withResponse.length,
      average: average(
        withResponse.map((ticket) => {
          const first = ticket.first_response_at;
          return first === null ? 0 : (first.getTime() - ticket.created_at.getTime()) / 1000;
        }),
      ),
    },
    resolution_seconds: {
      count: resolved.length,
      average: average(
        resolved.map((ticket) => {
          const closed = ticket.resolved_at;
          return closed === null ? 0 : (closed.getTime() - ticket.created_at.getTime()) / 1000;
        }),
      ),
    },
    csat,
    by_category: [...categories.entries()].map(([category_id, counts]) => ({
      category_id,
      ...counts,
    })),
    by_agent: [...agents.entries()].map(([agent_id, closed]) => ({ agent_id, closed })),
    guest_tickets: recent.filter((ticket) => ticket.guest_email !== null).length,
  };
}

export async function sweepClosedTickets(
  db: Kysely<Database>,
  options: { retention: number; now: Date; store?: ObjectStore | null },
): Promise<number> {
  const cutoff = new Date(options.now.getTime() - options.retention);
  const doomed = await db
    .selectFrom('tickets')
    .select('id')
    .where('status', '=', 'closed')
    .where('resolved_at', '<', cutoff)
    .execute();
  if (doomed.length === 0) return 0;
  if (options.store) {
    for (const ticket of doomed)
      await options.store.deletePrefix(attachmentObjectPrefix(ticket.id));
  }
  const result = await db
    .deleteFrom('tickets')
    .where(
      'id',
      'in',
      doomed.map((ticket) => ticket.id),
    )
    .executeTakeFirst();
  return Number(result.numDeletedRows);
}

export async function exportUserTickets(
  db: Kysely<Database>,
  userId: string,
  store: ObjectStore | null = null,
): Promise<Record<string, unknown>[]> {
  const tickets = await db
    .selectFrom('tickets')
    .select([
      'id',
      'number',
      'category_id',
      'subject',
      'status',
      'priority',
      'appeal',
      'action_id',
      'rating',
      'created_at',
      'resolved_at',
    ])
    .where('user_id', '=', userId)
    .orderBy('created_at', 'desc')
    .execute();
  const messages =
    tickets.length === 0
      ? []
      : await db
          .selectFrom('ticket_messages')
          .select(['ticket_id', 'staff', 'body', 'created_at'])
          .where(
            'ticket_id',
            'in',
            tickets.map((row) => row.id),
          )
          .orderBy('created_at', 'asc')
          .execute();
  const byTicket = new Map<string, Record<string, unknown>[]>();
  for (const message of messages) {
    const list = byTicket.get(message.ticket_id) ?? [];
    list.push({
      staff: message.staff,
      body: message.body,
      created_at: message.created_at.toISOString(),
    });
    byTicket.set(message.ticket_id, list);
  }
  const files =
    tickets.length === 0
      ? []
      : await db
          .selectFrom('ticket_attachments')
          .selectAll()
          .where(
            'ticket_id',
            'in',
            tickets.map((row) => row.id),
          )
          .orderBy('created_at', 'asc')
          .execute();
  const filesByTicket = new Map<string, Record<string, unknown>[]>();
  for (const file of files) {
    const bytes = store === null ? undefined : await store.get(file.object_key);
    const list = filesByTicket.get(file.ticket_id) ?? [];
    list.push({
      filename: file.filename,
      content_type: file.content_type,
      size_bytes: file.size_bytes,
      created_at: file.created_at.toISOString(),
      content_base64: bytes === undefined ? null : Buffer.from(bytes).toString('base64'),
    });
    filesByTicket.set(file.ticket_id, list);
  }
  return tickets.map((ticket) => ({
    id: ticket.id,
    number: ticket.number,
    category_id: ticket.category_id,
    subject: ticket.subject,
    status: ticket.status,
    priority: ticket.priority,
    appeal: ticket.appeal,
    action_id: ticket.action_id,
    rating: ticket.rating,
    created_at: ticket.created_at.toISOString(),
    resolved_at: ticket.resolved_at?.toISOString() ?? null,
    messages: byTicket.get(ticket.id) ?? [],
    attachments: filesByTicket.get(ticket.id) ?? [],
  }));
}

export async function eraseUserTickets(
  trx: Kysely<Database>,
  userId: string,
  store: ObjectStore | null = null,
): Promise<void> {
  const tickets = await trx
    .selectFrom('tickets')
    .select('id')
    .where('user_id', '=', userId)
    .execute();
  const ids = tickets.map((row) => row.id);
  if (ids.length > 0) {
    await trx
      .updateTable('ticket_messages')
      .set({ body: '', author_id: null })
      .where('ticket_id', 'in', ids)
      .where('staff', '=', false)
      .execute();
    await trx.updateTable('ticket_notes').set({ body: '' }).where('ticket_id', 'in', ids).execute();
    if (store !== null) {
      for (const id of ids) await store.deletePrefix(attachmentObjectPrefix(id));
    }
    await trx.deleteFrom('ticket_attachments').where('ticket_id', 'in', ids).execute();
  }
  await trx
    .updateTable('tickets')
    .set({ user_id: null, subject: '', rating: null })
    .where('user_id', '=', userId)
    .execute();
}
