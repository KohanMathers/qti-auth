import {
  decodeCursor,
  pageOf,
  pageSchema,
  paginationQuery,
  ProblemError,
  type Router,
} from '@qtiauth/service-kit';
import * as z from 'zod';

import {
  addAttachment,
  getAttachment,
  listAttachments,
  presentedAttachment,
  signAttachmentDownload,
} from './attachments.ts';
import { loadCategories } from './categories.ts';
import { TICKET_STATUSES } from './database.ts';
import { refreshOpenTickets, supportMetrics } from './metrics.ts';
import { queueNewTicketStaff, queueUserStatus } from './notify.ts';
import type { Context } from './service.ts';
import { objectStoreOf } from './storage-state.ts';
import {
  closeTicket,
  createAppealTicket,
  createTicket,
  getTicket,
  listTicketMessages,
  listUserTickets,
  rateTicket,
  reopenTicket,
  replyToTicket,
  type TicketMessage,
  type TicketRecord,
} from './tickets.ts';

const createdPosition = z.object({ created_at: z.iso.datetime(), id: z.uuid() });

const ticketSchema = z.object({
  id: z.uuid(),
  number: z.int(),
  category_id: z.string(),
  subject: z.string(),
  status: z.enum(TICKET_STATUSES),
  priority: z.string(),
  appeal: z.boolean(),
  action_id: z.uuid().nullable(),
  rating: z.int().min(1).max(5).nullable(),
  created_at: z.iso.datetime(),
  resolved_at: z.iso.datetime().nullable(),
});

const messageSchema = z.object({
  id: z.uuid(),
  staff: z.boolean(),
  body: z.string(),
  created_at: z.iso.datetime(),
});

const attachmentSchema = z.object({
  id: z.uuid(),
  filename: z.string(),
  content_type: z.string(),
  size_bytes: z.int(),
  created_at: z.iso.datetime(),
});

const ticketDetailSchema = ticketSchema.extend({
  messages: z.array(messageSchema),
  attachments: z.array(attachmentSchema),
});

const attachmentBody = z.object({
  filename: z.string().min(1).max(200),
  content: z
    .string()
    .min(1)
    .max(70_000_000)
    .describe('Base64-encoded file. The type is sniffed from the bytes, not the filename.'),
});

const downloadSchema = z.object({
  url: z.string(),
  expires_at: z.iso.datetime(),
});

const createBody = z.object({
  category_id: z.string().min(1),
  subject: z.string().min(1),
  body: z.string().min(1),
});

const appealBody = z.object({
  action_id: z.uuid().optional(),
  body: z.string().min(1),
});

const replyBody = z.object({
  body: z.string().min(1),
});

const rateBody = z.object({
  rating: z.int().min(1).max(5),
});

const categorySchema = z.object({
  id: z.string(),
  name: z.string(),
  guest_allowed: z.boolean(),
  appeal: z.boolean(),
});

export function presentedTicket(ticket: TicketRecord) {
  return {
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
  };
}

export const NO_STORE = { 'cache-control': 'no-store' };

function presentedMessage(message: TicketMessage) {
  return {
    id: message.id,
    staff: message.staff,
    body: message.body,
    created_at: message.created_at.toISOString(),
  };
}

export function signedIn(identity: { sub: string | null }): string {
  if (identity.sub === null) throw new ProblemError('IDENTITY_TOKEN_INVALID');
  return identity.sub;
}

export function ensureTickets(enabled: boolean): void {
  if (!enabled) throw new ProblemError('SUPPORT_TICKETS_DISABLED');
}

async function visibleAttachments(ctx: Context, ticketId: string) {
  if (!ctx.config.features.support.attachments.enabled) return [];
  return listAttachments(ctx.db, ticketId);
}

export async function userTicketDetail(ctx: Context, ticket: TicketRecord) {
  const [messages, attachments] = await Promise.all([
    listTicketMessages(ctx.db, ticket.id),
    visibleAttachments(ctx, ticket.id),
  ]);
  return {
    ...presentedTicket(ticket),
    messages: messages.map(presentedMessage),
    attachments: attachments.map((row) => presentedAttachment(row)),
  };
}

export function attachmentStore(ctx: Context) {
  ensureTickets(ctx.config.features.support.tickets.enabled);
  if (!ctx.config.features.support.attachments.enabled) {
    throw new ProblemError('SUPPORT_ATTACHMENTS_DISABLED');
  }
  const store = objectStoreOf(ctx);
  if (store == null) throw new ProblemError('SUPPORT_STORAGE_UNAVAILABLE');
  return store;
}

async function ownedTicket(ctx: Context, ticketId: string, userId: string): Promise<TicketRecord> {
  const ticket = await getTicket(ctx.db, ticketId);
  if (ticket?.user_id !== userId) throw new ProblemError('SUPPORT_TICKET_NOT_FOUND');
  return ticket;
}

export function ticketRoutes(router: Router<Context>): void {
  router.route({
    method: 'GET',
    path: '/api/v1/support/categories',
    operation_id: 'listTicketCategories',
    summary: 'Ticket categories',
    tags: ['support'],
    auth: 'session',
    rate_limit: 'global',
    responses: {
      200: {
        description: 'Categories that can be chosen when opening a ticket',
        schema: z.object({ items: z.array(categorySchema) }),
      },
    },
    errors: ['SUPPORT_TICKETS_DISABLED'],
    handler: ({ ctx }) => {
      ensureTickets(ctx.config.features.support.tickets.enabled);
      const items = [...loadCategories(ctx.config.support).values()].filter(
        (category) => !category.appeal,
      );
      return Promise.resolve({ status: 200 as const, body: { items } });
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/support/tickets',
    operation_id: 'createTicket',
    summary: 'Open a support ticket',
    tags: ['support'],
    auth: 'session',
    rate_limit: 'ticket_create',
    request: { body: createBody },
    responses: { 201: { description: 'The ticket', schema: ticketDetailSchema } },
    errors: [
      'SUPPORT_TICKETS_DISABLED',
      'SUPPORT_CATEGORY_UNKNOWN',
      'SUPPORT_CATEGORY_APPEAL',
      'SUPPORT_TICKET_INVALID',
    ],
    handler: async ({ ctx, identity, body }) => {
      ensureTickets(ctx.config.features.support.tickets.enabled);
      const userId = signedIn(identity);
      const categories = loadCategories(ctx.config.support);
      const result = await createTicket(ctx.db, {
        userId,
        categoryId: body.category_id,
        subject: body.subject,
        body: body.body,
        categories,
        maxSubject: ctx.config.support.max_subject_length,
        maxBody: ctx.config.support.max_body_length,
        now: new Date(),
      });
      if (result.status === 'too_long') throw new ProblemError('SUPPORT_TICKET_INVALID');
      if (result.status === 'unknown_category') throw new ProblemError('SUPPORT_CATEGORY_UNKNOWN');
      if (result.status === 'appeal_category') throw new ProblemError('SUPPORT_CATEGORY_APPEAL');
      ctx.outbox.wake();
      supportMetrics(ctx.metrics).created(result.ticket.category_id);
      await refreshOpenTickets(ctx.db, ctx.metrics, ctx.config.support);
      await queueNewTicketStaff(ctx, result.ticket, categories);
      return { status: 201 as const, body: await userTicketDetail(ctx, result.ticket) };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/support/appeals',
    operation_id: 'createAppealTicket',
    summary: 'Appeal a lock, ban or restriction',
    description:
      'Banned and locked accounts can open exactly one appeal per enforcement action. The category is forced to the appeal type.',
    tags: ['support'],
    auth: 'session',
    allow_account_states: ['active', 'banned', 'locked'],
    rate_limit: 'ticket_create',
    request: { body: appealBody },
    responses: { 201: { description: 'The appeal ticket', schema: ticketDetailSchema } },
    errors: [
      'SUPPORT_TICKETS_DISABLED',
      'SUPPORT_CATEGORY_UNKNOWN',
      'SUPPORT_APPEAL_EXISTS',
      'SUPPORT_TICKET_INVALID',
    ],
    handler: async ({ ctx, identity, body }) => {
      ensureTickets(ctx.config.features.support.tickets.enabled);
      const userId = signedIn(identity);
      const categories = loadCategories(ctx.config.support);
      const result = await createAppealTicket(ctx.db, {
        userId,
        actionId: body.action_id ?? null,
        body: body.body,
        categories,
        maxBody: ctx.config.support.max_body_length,
        now: new Date(),
      });
      if (result.status === 'too_long') throw new ProblemError('SUPPORT_TICKET_INVALID');
      if (result.status === 'unknown_category') throw new ProblemError('SUPPORT_CATEGORY_UNKNOWN');
      if (result.status === 'exists') throw new ProblemError('SUPPORT_APPEAL_EXISTS');
      ctx.outbox.wake();
      supportMetrics(ctx.metrics).created(result.ticket.category_id);
      await refreshOpenTickets(ctx.db, ctx.metrics, ctx.config.support);
      await queueNewTicketStaff(ctx, result.ticket, categories);
      return { status: 201 as const, body: await userTicketDetail(ctx, result.ticket) };
    },
  });

  router.route({
    method: 'GET',
    path: '/api/v1/support/tickets',
    operation_id: 'listMyTickets',
    summary: 'Tickets you opened',
    tags: ['support'],
    auth: 'session',
    allow_account_states: ['active', 'banned', 'locked'],
    rate_limit: 'global',
    request: { query: paginationQuery({ defaultLimit: 25, maxLimit: 100 }) },
    responses: { 200: { description: 'Your tickets', schema: pageSchema(ticketSchema) } },
    errors: ['SUPPORT_TICKETS_DISABLED'],
    handler: async ({ ctx, identity, query }) => {
      ensureTickets(ctx.config.features.support.tickets.enabled);
      const after = decodeCursor(createdPosition, query.cursor);
      const rows = await listUserTickets(ctx.db, {
        userId: signedIn(identity),
        ...(after === undefined ? {} : { after }),
        limit: query.limit + 1,
      });
      const page = pageOf(rows, query.limit, (ticket) => ({
        created_at: ticket.created_at.toISOString(),
        id: ticket.id,
      }));
      return {
        status: 200 as const,
        body: {
          items: page.items.map(presentedTicket),
          next_cursor: page.next_cursor,
        },
      };
    },
  });

  router.route({
    method: 'GET',
    path: '/api/v1/support/tickets/:ticket_id',
    operation_id: 'getMyTicket',
    summary: 'A ticket you opened',
    tags: ['support'],
    auth: 'session',
    allow_account_states: ['active', 'banned', 'locked'],
    rate_limit: 'global',
    request: { params: z.object({ ticket_id: z.uuid() }) },
    responses: { 200: { description: 'The ticket', schema: ticketDetailSchema } },
    errors: ['SUPPORT_TICKETS_DISABLED', 'SUPPORT_TICKET_NOT_FOUND'],
    handler: async ({ ctx, identity, params }) => {
      ensureTickets(ctx.config.features.support.tickets.enabled);
      const ticket = await ownedTicket(ctx, params.ticket_id, signedIn(identity));
      return { status: 200 as const, body: await userTicketDetail(ctx, ticket) };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/support/tickets/:ticket_id/replies',
    operation_id: 'replyToTicket',
    summary: 'Reply to your ticket',
    tags: ['support'],
    auth: 'session',
    allow_account_states: ['active', 'banned', 'locked'],
    rate_limit: 'global',
    request: { params: z.object({ ticket_id: z.uuid() }), body: replyBody },
    responses: { 200: { description: 'The ticket', schema: ticketDetailSchema } },
    errors: [
      'SUPPORT_TICKETS_DISABLED',
      'SUPPORT_TICKET_NOT_FOUND',
      'SUPPORT_TICKET_CLOSED',
      'SUPPORT_TICKET_INVALID',
    ],
    handler: async ({ ctx, identity, params, body }) => {
      ensureTickets(ctx.config.features.support.tickets.enabled);
      const userId = signedIn(identity);
      await ownedTicket(ctx, params.ticket_id, userId);
      const result = await replyToTicket(ctx.db, {
        ticketId: params.ticket_id,
        authorId: userId,
        staff: false,
        body: body.body,
        maxBody: ctx.config.support.max_body_length,
        now: new Date(),
      });
      if (result.status === 'not_found') throw new ProblemError('SUPPORT_TICKET_NOT_FOUND');
      if (result.status === 'closed') throw new ProblemError('SUPPORT_TICKET_CLOSED');
      if (result.status === 'too_long') throw new ProblemError('SUPPORT_TICKET_INVALID');
      ctx.outbox.wake();
      await refreshOpenTickets(ctx.db, ctx.metrics, ctx.config.support);
      return { status: 200 as const, body: await userTicketDetail(ctx, result.ticket) };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/support/tickets/:ticket_id/close',
    operation_id: 'closeMyTicket',
    summary: 'Close your ticket',
    tags: ['support'],
    auth: 'session',
    allow_account_states: ['active', 'banned', 'locked'],
    rate_limit: 'global',
    request: { params: z.object({ ticket_id: z.uuid() }) },
    responses: { 200: { description: 'The ticket', schema: ticketSchema } },
    errors: ['SUPPORT_TICKETS_DISABLED', 'SUPPORT_TICKET_NOT_FOUND', 'SUPPORT_TICKET_CLOSED'],
    handler: async ({ ctx, identity, params }) => {
      ensureTickets(ctx.config.features.support.tickets.enabled);
      const userId = signedIn(identity);
      await ownedTicket(ctx, params.ticket_id, userId);
      const result = await closeTicket(ctx.db, {
        ticketId: params.ticket_id,
        actor: { type: 'user', id: userId },
        now: new Date(),
      });
      if (result.status === 'not_found') throw new ProblemError('SUPPORT_TICKET_NOT_FOUND');
      if (result.status === 'closed') throw new ProblemError('SUPPORT_TICKET_CLOSED');
      ctx.outbox.wake();
      await refreshOpenTickets(ctx.db, ctx.metrics, ctx.config.support);
      const resolvedAt = result.ticket.resolved_at;
      if (resolvedAt !== null) {
        supportMetrics(ctx.metrics).resolution(
          (resolvedAt.getTime() - result.ticket.created_at.getTime()) / 1000,
        );
      }
      await queueUserStatus(ctx, result.ticket);
      return { status: 200 as const, body: presentedTicket(result.ticket) };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/support/tickets/:ticket_id/reopen',
    operation_id: 'reopenMyTicket',
    summary: 'Reopen your ticket',
    tags: ['support'],
    auth: 'session',
    allow_account_states: ['active', 'banned', 'locked'],
    rate_limit: 'global',
    request: { params: z.object({ ticket_id: z.uuid() }) },
    responses: { 200: { description: 'The ticket', schema: ticketSchema } },
    errors: ['SUPPORT_TICKETS_DISABLED', 'SUPPORT_TICKET_NOT_FOUND', 'SUPPORT_TICKET_OPEN'],
    handler: async ({ ctx, identity, params }) => {
      ensureTickets(ctx.config.features.support.tickets.enabled);
      const userId = signedIn(identity);
      await ownedTicket(ctx, params.ticket_id, userId);
      const result = await reopenTicket(ctx.db, {
        ticketId: params.ticket_id,
        actor: { type: 'user', id: userId },
        now: new Date(),
      });
      if (result.status === 'not_found') throw new ProblemError('SUPPORT_TICKET_NOT_FOUND');
      if (result.status === 'open') throw new ProblemError('SUPPORT_TICKET_OPEN');
      ctx.outbox.wake();
      await refreshOpenTickets(ctx.db, ctx.metrics, ctx.config.support);
      await queueUserStatus(ctx, result.ticket);
      return { status: 200 as const, body: presentedTicket(result.ticket) };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/support/tickets/:ticket_id/rate',
    operation_id: 'rateTicket',
    summary: 'Rate a closed ticket',
    tags: ['support'],
    auth: 'session',
    allow_account_states: ['active', 'banned', 'locked'],
    rate_limit: 'global',
    request: { params: z.object({ ticket_id: z.uuid() }), body: rateBody },
    responses: { 200: { description: 'The ticket', schema: ticketSchema } },
    errors: [
      'SUPPORT_TICKETS_DISABLED',
      'SUPPORT_TICKET_NOT_FOUND',
      'SUPPORT_TICKET_OPEN',
      'SUPPORT_TICKET_RATED',
    ],
    handler: async ({ ctx, identity, params, body }) => {
      ensureTickets(ctx.config.features.support.tickets.enabled);
      const result = await rateTicket(ctx.db, {
        ticketId: params.ticket_id,
        userId: signedIn(identity),
        rating: body.rating,
        now: new Date(),
      });
      if (result.status === 'not_found') throw new ProblemError('SUPPORT_TICKET_NOT_FOUND');
      if (result.status === 'open') throw new ProblemError('SUPPORT_TICKET_OPEN');
      if (result.status === 'rated') throw new ProblemError('SUPPORT_TICKET_RATED');
      supportMetrics(ctx.metrics).csat(body.rating);
      return { status: 200 as const, body: presentedTicket(result.ticket) };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/support/tickets/:ticket_id/attachments',
    operation_id: 'addTicketAttachment',
    summary: 'Attach a file to your ticket',
    description:
      'Images, PDF and plain text only. The type is sniffed from the bytes. HTML, including a renamed .html file, is rejected.',
    tags: ['support'],
    auth: 'session',
    allow_account_states: ['active', 'banned', 'locked'],
    rate_limit: 'global',
    request: { params: z.object({ ticket_id: z.uuid() }), body: attachmentBody },
    responses: { 201: { description: 'The attachment', schema: attachmentSchema } },
    errors: [
      'SUPPORT_TICKETS_DISABLED',
      'SUPPORT_ATTACHMENTS_DISABLED',
      'SUPPORT_STORAGE_UNAVAILABLE',
      'SUPPORT_TICKET_NOT_FOUND',
      'SUPPORT_TICKET_CLOSED',
      'SUPPORT_ATTACHMENT_INVALID',
    ],
    handler: async ({ ctx, identity, params, body }) => {
      const store = attachmentStore(ctx);
      await ownedTicket(ctx, params.ticket_id, signedIn(identity));
      const result = await addAttachment(ctx.db, store, {
        ticketId: params.ticket_id,
        filename: body.filename,
        content: body.content,
        maxBytes: ctx.config.support.attachment_max_bytes,
        now: new Date(),
      });
      if (result.status === 'not_found') throw new ProblemError('SUPPORT_TICKET_NOT_FOUND');
      if (result.status === 'closed') throw new ProblemError('SUPPORT_TICKET_CLOSED');
      if (result.status === 'invalid') throw new ProblemError('SUPPORT_ATTACHMENT_INVALID');
      return {
        status: 201 as const,
        body: presentedAttachment(result.attachment),
      };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/support/tickets/:ticket_id/attachments/:attachment_id/download',
    operation_id: 'downloadTicketAttachment',
    summary: 'Signed download URL for an attachment on your ticket',
    description:
      'The URL responds with Content-Disposition: attachment, so the browser downloads it.',
    tags: ['support'],
    auth: 'session',
    allow_account_states: ['active', 'banned', 'locked'],
    rate_limit: 'global',
    request: {
      params: z.object({ ticket_id: z.uuid(), attachment_id: z.uuid() }),
    },
    responses: { 200: { description: 'A short-lived download URL', schema: downloadSchema } },
    errors: [
      'SUPPORT_TICKETS_DISABLED',
      'SUPPORT_ATTACHMENTS_DISABLED',
      'SUPPORT_STORAGE_UNAVAILABLE',
      'SUPPORT_TICKET_NOT_FOUND',
      'SUPPORT_ATTACHMENT_NOT_FOUND',
    ],
    handler: async ({ ctx, identity, params }) => {
      const store = attachmentStore(ctx);
      const ticket = await ownedTicket(ctx, params.ticket_id, signedIn(identity));
      const attachment = await getAttachment(ctx.db, params.attachment_id);
      if (attachment?.ticket_id !== ticket.id)
        throw new ProblemError('SUPPORT_ATTACHMENT_NOT_FOUND');
      const signed = await signAttachmentDownload(
        store,
        attachment,
        ctx.config.support.attachment_download_ttl,
        new Date(),
      );
      return {
        status: 200 as const,
        headers: NO_STORE,
        body: { url: signed.url, expires_at: signed.expiresAt.toISOString() },
      };
    },
  });
}
