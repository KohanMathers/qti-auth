import { SUPPORT_MACRO_NAME_MAX, SUPPORT_PRIORITIES } from '@qtiauth/config';
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
  presentedStaffAttachment,
  signAttachmentDownload,
} from './attachments.ts';
import { loadCategories } from './categories.ts';
import { TICKET_STATUSES } from './database.ts';
import {
  createMacro,
  deleteMacro,
  getMacro,
  listMacros,
  type MacroRecord,
  updateMacro,
} from './macros.ts';
import { refreshOpenTickets, supportMetrics } from './metrics.ts';
import { queueUserReply, queueUserStatus } from './notify.ts';
import { attachmentStore, ensureTickets, NO_STORE, presentedTicket, signedIn } from './routes.ts';
import type { Context } from './service.ts';
import {
  addNote,
  closeTicket,
  getTicket,
  listQueue,
  listTicketMessages,
  listTicketNotes,
  reopenTicket,
  replyToTicket,
  staffMetricsSnapshot,
  type TicketRecord,
  updateTicket,
} from './tickets.ts';

const createdPosition = z.object({ created_at: z.iso.datetime(), id: z.uuid() });

const queueQuery = paginationQuery({ defaultLimit: 25, maxLimit: 100 }).extend({
  status: z.enum(TICKET_STATUSES).optional(),
  category: z.string().min(1).optional(),
  priority: z.enum(SUPPORT_PRIORITIES).optional(),
  assigned_to: z.uuid().nullable().optional(),
});

const staffTicketSchema = z.object({
  id: z.uuid(),
  number: z.int(),
  user_id: z.uuid().nullable(),
  category_id: z.string(),
  subject: z.string(),
  status: z.enum(TICKET_STATUSES),
  priority: z.string(),
  appeal: z.boolean(),
  action_id: z.uuid().nullable(),
  assigned_to: z.uuid().nullable(),
  guest_email: z.string().nullable(),
  rating: z.int().min(1).max(5).nullable(),
  created_at: z.iso.datetime(),
  resolved_at: z.iso.datetime().nullable(),
});

const messageSchema = z.object({
  id: z.uuid(),
  staff: z.boolean(),
  author_id: z.uuid().nullable(),
  body: z.string(),
  created_at: z.iso.datetime(),
});

const noteSchema = z.object({
  id: z.uuid(),
  author_id: z.uuid(),
  body: z.string(),
  created_at: z.iso.datetime(),
});

const staffAttachmentSchema = z.object({
  id: z.uuid(),
  filename: z.string(),
  content_type: z.string(),
  size_bytes: z.int(),
  created_at: z.iso.datetime(),
  warning: z.boolean(),
});

const staffDetailSchema = staffTicketSchema.extend({
  messages: z.array(messageSchema),
  notes: z.array(noteSchema),
  attachments: z.array(staffAttachmentSchema),
});

const replyBody = z.object({
  body: z.string().min(1).optional(),
  macro_id: z.uuid().optional(),
});

const noteBody = z.object({
  body: z.string().min(1),
});

const patchBody = z.object({
  assigned_to: z.uuid().nullable().optional(),
  priority: z.enum(SUPPORT_PRIORITIES).optional(),
  category_id: z.string().min(1).optional(),
});

const macroSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  body: z.string(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});

const macroBody = z.object({
  name: z.string().min(1),
  body: z.string().min(1),
});

const macroPatch = z.object({
  name: z.string().min(1).optional(),
  body: z.string().min(1).optional(),
});

const metricsSchema = z.object({
  first_response_seconds: z.object({ count: z.int(), average: z.number().nullable() }),
  resolution_seconds: z.object({ count: z.int(), average: z.number().nullable() }),
  csat: z.array(z.object({ rating: z.int(), count: z.int() })),
  by_category: z.array(
    z.object({
      category_id: z.string(),
      open: z.int(),
      pending: z.int(),
      closed: z.int(),
    }),
  ),
  by_agent: z.array(z.object({ agent_id: z.uuid(), closed: z.int() })),
  guest_tickets: z.int(),
});

function presentedStaffTicket(ticket: TicketRecord) {
  return {
    ...presentedTicket(ticket),
    user_id: ticket.user_id,
    guest_email: ticket.guest_email,
    assigned_to: ticket.assigned_to,
  };
}

function presentedMacro(macro: MacroRecord) {
  return {
    id: macro.id,
    name: macro.name,
    body: macro.body,
    created_at: macro.created_at.toISOString(),
    updated_at: macro.updated_at.toISOString(),
  };
}

async function staffDetail(ctx: Context, ticket: TicketRecord) {
  const [messages, notes, attachments] = await Promise.all([
    listTicketMessages(ctx.db, ticket.id),
    listTicketNotes(ctx.db, ticket.id),
    ctx.config.features.support.attachments.enabled
      ? listAttachments(ctx.db, ticket.id)
      : Promise.resolve([]),
  ]);
  return {
    ...presentedStaffTicket(ticket),
    messages: messages.map((message) => ({
      id: message.id,
      staff: message.staff,
      author_id: message.author_id,
      body: message.body,
      created_at: message.created_at.toISOString(),
    })),
    notes: notes.map((note) => ({
      id: note.id,
      author_id: note.author_id,
      body: note.body,
      created_at: note.created_at.toISOString(),
    })),
    attachments: attachments.map((row) => presentedStaffAttachment(row)),
  };
}

export function staffRoutes(router: Router<Context>): void {
  router.route({
    method: 'GET',
    path: '/api/v1/admin/support/tickets',
    operation_id: 'listSupportTickets',
    summary: 'Support ticket queue',
    tags: ['support'],
    auth: 'session',
    permissions: ['support.tickets.staff'],
    rate_limit: 'global',
    request: { query: queueQuery },
    responses: { 200: { description: 'The queue', schema: pageSchema(staffTicketSchema) } },
    errors: ['SUPPORT_TICKETS_DISABLED'],
    handler: async ({ ctx, query }) => {
      ensureTickets(ctx.config.features.support.tickets.enabled);
      const after = decodeCursor(createdPosition, query.cursor);
      const rows = await listQueue(ctx.db, {
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.category === undefined ? {} : { category: query.category }),
        ...(query.priority === undefined ? {} : { priority: query.priority }),
        ...(query.assigned_to === undefined ? {} : { assignedTo: query.assigned_to }),
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
          items: page.items.map(presentedStaffTicket),
          next_cursor: page.next_cursor,
        },
      };
    },
  });

  router.route({
    method: 'GET',
    path: '/api/v1/admin/support/tickets/:ticket_id',
    operation_id: 'getSupportTicket',
    summary: 'A ticket in the queue',
    tags: ['support'],
    auth: 'session',
    permissions: ['support.tickets.staff'],
    rate_limit: 'global',
    request: { params: z.object({ ticket_id: z.uuid() }) },
    responses: { 200: { description: 'The ticket', schema: staffDetailSchema } },
    errors: ['SUPPORT_TICKETS_DISABLED', 'SUPPORT_TICKET_NOT_FOUND'],
    handler: async ({ ctx, params }) => {
      ensureTickets(ctx.config.features.support.tickets.enabled);
      const ticket = await getTicket(ctx.db, params.ticket_id);
      if (!ticket) throw new ProblemError('SUPPORT_TICKET_NOT_FOUND');
      return { status: 200 as const, body: await staffDetail(ctx, ticket) };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/admin/support/tickets/:ticket_id/replies',
    operation_id: 'staffReplyToTicket',
    summary: 'Reply to a ticket as staff',
    tags: ['support'],
    auth: 'session',
    permissions: ['support.tickets.staff'],
    rate_limit: 'global',
    request: { params: z.object({ ticket_id: z.uuid() }), body: replyBody },
    responses: { 200: { description: 'The ticket', schema: staffDetailSchema } },
    errors: [
      'SUPPORT_TICKETS_DISABLED',
      'SUPPORT_TICKET_NOT_FOUND',
      'SUPPORT_TICKET_CLOSED',
      'SUPPORT_TICKET_INVALID',
      'SUPPORT_MACRO_NOT_FOUND',
    ],
    handler: async ({ ctx, identity, params, body }) => {
      ensureTickets(ctx.config.features.support.tickets.enabled);
      const staffId = signedIn(identity);
      let text = body.body ?? '';
      if (body.macro_id !== undefined) {
        const macro = await getMacro(ctx.db, body.macro_id);
        if (!macro) throw new ProblemError('SUPPORT_MACRO_NOT_FOUND');
        text = macro.body;
      }
      if (text.length === 0) throw new ProblemError('SUPPORT_TICKET_INVALID');
      const result = await replyToTicket(ctx.db, {
        ticketId: params.ticket_id,
        authorId: staffId,
        staff: true,
        body: text,
        maxBody: ctx.config.support.max_body_length,
        now: new Date(),
      });
      if (result.status === 'not_found') throw new ProblemError('SUPPORT_TICKET_NOT_FOUND');
      if (result.status === 'closed') throw new ProblemError('SUPPORT_TICKET_CLOSED');
      if (result.status === 'too_long') throw new ProblemError('SUPPORT_TICKET_INVALID');
      ctx.outbox.wake();
      if (result.firstResponseSeconds !== null) {
        supportMetrics(ctx.metrics).firstResponse(result.firstResponseSeconds);
      }
      await refreshOpenTickets(ctx.db, ctx.metrics, ctx.config.support);
      await queueUserReply(ctx, result.ticket);
      return { status: 200 as const, body: await staffDetail(ctx, result.ticket) };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/admin/support/tickets/:ticket_id/notes',
    operation_id: 'addTicketNote',
    summary: 'Add an internal note',
    tags: ['support'],
    auth: 'session',
    permissions: ['support.tickets.staff'],
    rate_limit: 'global',
    request: { params: z.object({ ticket_id: z.uuid() }), body: noteBody },
    responses: { 200: { description: 'The ticket', schema: staffDetailSchema } },
    errors: ['SUPPORT_TICKETS_DISABLED', 'SUPPORT_TICKET_NOT_FOUND', 'SUPPORT_TICKET_INVALID'],
    handler: async ({ ctx, identity, params, body }) => {
      ensureTickets(ctx.config.features.support.tickets.enabled);
      const result = await addNote(ctx.db, {
        ticketId: params.ticket_id,
        authorId: signedIn(identity),
        body: body.body,
        maxBody: ctx.config.support.max_body_length,
        now: new Date(),
      });
      if (result.status === 'not_found') throw new ProblemError('SUPPORT_TICKET_NOT_FOUND');
      if (result.status === 'too_long') throw new ProblemError('SUPPORT_TICKET_INVALID');
      ctx.outbox.wake();
      return { status: 200 as const, body: await staffDetail(ctx, result.ticket) };
    },
  });

  router.route({
    method: 'PATCH',
    path: '/api/v1/admin/support/tickets/:ticket_id',
    operation_id: 'updateSupportTicket',
    summary: 'Assign, recategorise or change priority',
    tags: ['support'],
    auth: 'session',
    permissions: ['support.tickets.staff'],
    rate_limit: 'global',
    request: { params: z.object({ ticket_id: z.uuid() }), body: patchBody },
    responses: { 200: { description: 'The ticket', schema: staffTicketSchema } },
    errors: [
      'SUPPORT_TICKETS_DISABLED',
      'SUPPORT_TICKET_NOT_FOUND',
      'SUPPORT_CATEGORY_UNKNOWN',
      'SUPPORT_CATEGORY_APPEAL',
    ],
    handler: async ({ ctx, identity, params, body }) => {
      ensureTickets(ctx.config.features.support.tickets.enabled);
      const result = await updateTicket(ctx.db, {
        ticketId: params.ticket_id,
        actorId: signedIn(identity),
        ...(body.assigned_to === undefined ? {} : { assignedTo: body.assigned_to }),
        ...(body.priority === undefined ? {} : { priority: body.priority }),
        ...(body.category_id === undefined ? {} : { categoryId: body.category_id }),
        categories: loadCategories(ctx.config.support),
        now: new Date(),
      });
      if (result.status === 'not_found') throw new ProblemError('SUPPORT_TICKET_NOT_FOUND');
      if (result.status === 'unknown_category') throw new ProblemError('SUPPORT_CATEGORY_UNKNOWN');
      if (result.status === 'appeal_category') throw new ProblemError('SUPPORT_CATEGORY_APPEAL');
      ctx.outbox.wake();
      return { status: 200 as const, body: presentedStaffTicket(result.ticket) };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/admin/support/tickets/:ticket_id/close',
    operation_id: 'staffCloseTicket',
    summary: 'Close a ticket',
    tags: ['support'],
    auth: 'session',
    permissions: ['support.tickets.staff'],
    rate_limit: 'global',
    request: { params: z.object({ ticket_id: z.uuid() }) },
    responses: { 200: { description: 'The ticket', schema: staffTicketSchema } },
    errors: ['SUPPORT_TICKETS_DISABLED', 'SUPPORT_TICKET_NOT_FOUND', 'SUPPORT_TICKET_CLOSED'],
    handler: async ({ ctx, identity, params }) => {
      ensureTickets(ctx.config.features.support.tickets.enabled);
      const result = await closeTicket(ctx.db, {
        ticketId: params.ticket_id,
        actor: { type: 'user', id: signedIn(identity) },
        now: new Date(),
        staff: true,
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
      return { status: 200 as const, body: presentedStaffTicket(result.ticket) };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/admin/support/tickets/:ticket_id/reopen',
    operation_id: 'staffReopenTicket',
    summary: 'Reopen a ticket',
    tags: ['support'],
    auth: 'session',
    permissions: ['support.tickets.staff'],
    rate_limit: 'global',
    request: { params: z.object({ ticket_id: z.uuid() }) },
    responses: { 200: { description: 'The ticket', schema: staffTicketSchema } },
    errors: ['SUPPORT_TICKETS_DISABLED', 'SUPPORT_TICKET_NOT_FOUND', 'SUPPORT_TICKET_OPEN'],
    handler: async ({ ctx, identity, params }) => {
      ensureTickets(ctx.config.features.support.tickets.enabled);
      const result = await reopenTicket(ctx.db, {
        ticketId: params.ticket_id,
        actor: { type: 'user', id: signedIn(identity) },
        now: new Date(),
        staff: true,
      });
      if (result.status === 'not_found') throw new ProblemError('SUPPORT_TICKET_NOT_FOUND');
      if (result.status === 'open') throw new ProblemError('SUPPORT_TICKET_OPEN');
      ctx.outbox.wake();
      await refreshOpenTickets(ctx.db, ctx.metrics, ctx.config.support);
      await queueUserStatus(ctx, result.ticket);
      return { status: 200 as const, body: presentedStaffTicket(result.ticket) };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/admin/support/tickets/:ticket_id/attachments',
    operation_id: 'addStaffAttachment',
    summary: 'Attach a file to a ticket',
    tags: ['support'],
    auth: 'session',
    permissions: ['support.tickets.staff'],
    rate_limit: 'global',
    request: {
      params: z.object({ ticket_id: z.uuid() }),
      body: z.object({
        filename: z.string().min(1).max(200),
        content: z.string().min(1).max(70_000_000),
      }),
    },
    responses: { 201: { description: 'The attachment', schema: staffAttachmentSchema } },
    errors: [
      'SUPPORT_TICKETS_DISABLED',
      'SUPPORT_ATTACHMENTS_DISABLED',
      'SUPPORT_STORAGE_UNAVAILABLE',
      'SUPPORT_TICKET_NOT_FOUND',
      'SUPPORT_TICKET_CLOSED',
      'SUPPORT_ATTACHMENT_INVALID',
    ],
    handler: async ({ ctx, params, body }) => {
      const store = attachmentStore(ctx);
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
      return { status: 201 as const, body: presentedStaffAttachment(result.attachment) };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/admin/support/tickets/:ticket_id/attachments/:attachment_id/download',
    operation_id: 'downloadStaffAttachment',
    summary: 'Signed download URL for an attachment',
    description:
      'Non-image files include warning: true on the ticket. The URL is always served as a download.',
    tags: ['support'],
    auth: 'session',
    permissions: ['support.tickets.staff'],
    rate_limit: 'global',
    request: { params: z.object({ ticket_id: z.uuid(), attachment_id: z.uuid() }) },
    responses: {
      200: {
        description: 'A short-lived download URL',
        schema: z.object({ url: z.string(), expires_at: z.iso.datetime() }),
      },
    },
    errors: [
      'SUPPORT_TICKETS_DISABLED',
      'SUPPORT_ATTACHMENTS_DISABLED',
      'SUPPORT_STORAGE_UNAVAILABLE',
      'SUPPORT_TICKET_NOT_FOUND',
      'SUPPORT_ATTACHMENT_NOT_FOUND',
    ],
    handler: async ({ ctx, params }) => {
      const store = attachmentStore(ctx);
      const ticket = await getTicket(ctx.db, params.ticket_id);
      if (!ticket) throw new ProblemError('SUPPORT_TICKET_NOT_FOUND');
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

  router.route({
    method: 'GET',
    path: '/api/v1/admin/support/macros',
    operation_id: 'listMacros',
    summary: 'Canned responses',
    tags: ['support'],
    auth: 'session',
    permissions: ['support.tickets.staff'],
    rate_limit: 'global',
    responses: {
      200: { description: 'Canned responses', schema: z.object({ items: z.array(macroSchema) }) },
    },
    handler: async ({ ctx }) => {
      ensureTickets(ctx.config.features.support.tickets.enabled);
      const items = await listMacros(ctx.db);
      return { status: 200 as const, body: { items: items.map(presentedMacro) } };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/admin/support/macros',
    operation_id: 'createMacro',
    summary: 'Create a canned response',
    tags: ['support'],
    auth: 'session',
    permissions: ['support.tickets.staff'],
    rate_limit: 'global',
    request: { body: macroBody },
    responses: { 201: { description: 'The canned response', schema: macroSchema } },
    errors: ['SUPPORT_TICKETS_DISABLED', 'SUPPORT_TICKET_INVALID'],
    handler: async ({ ctx, identity, body }) => {
      ensureTickets(ctx.config.features.support.tickets.enabled);
      const result = await createMacro(ctx.db, {
        name: body.name,
        body: body.body,
        actorId: signedIn(identity),
        maxName: SUPPORT_MACRO_NAME_MAX,
        maxBody: ctx.config.support.max_body_length,
        now: new Date(),
      });
      if (result.status === 'too_long') throw new ProblemError('SUPPORT_TICKET_INVALID');
      ctx.outbox.wake();
      return { status: 201 as const, body: presentedMacro(result.macro) };
    },
  });

  router.route({
    method: 'PATCH',
    path: '/api/v1/admin/support/macros/:macro_id',
    operation_id: 'updateMacro',
    summary: 'Edit a canned response',
    tags: ['support'],
    auth: 'session',
    permissions: ['support.tickets.staff'],
    rate_limit: 'global',
    request: { params: z.object({ macro_id: z.uuid() }), body: macroPatch },
    responses: { 200: { description: 'The canned response', schema: macroSchema } },
    errors: ['SUPPORT_TICKETS_DISABLED', 'SUPPORT_MACRO_NOT_FOUND', 'SUPPORT_TICKET_INVALID'],
    handler: async ({ ctx, identity, params, body }) => {
      ensureTickets(ctx.config.features.support.tickets.enabled);
      const result = await updateMacro(ctx.db, {
        id: params.macro_id,
        ...(body.name === undefined ? {} : { name: body.name }),
        ...(body.body === undefined ? {} : { body: body.body }),
        actorId: signedIn(identity),
        maxName: SUPPORT_MACRO_NAME_MAX,
        maxBody: ctx.config.support.max_body_length,
        now: new Date(),
      });
      if (result.status === 'not_found') throw new ProblemError('SUPPORT_MACRO_NOT_FOUND');
      if (result.status === 'too_long') throw new ProblemError('SUPPORT_TICKET_INVALID');
      ctx.outbox.wake();
      return { status: 200 as const, body: presentedMacro(result.macro) };
    },
  });

  router.route({
    method: 'DELETE',
    path: '/api/v1/admin/support/macros/:macro_id',
    operation_id: 'deleteMacro',
    summary: 'Delete a canned response',
    tags: ['support'],
    auth: 'session',
    permissions: ['support.tickets.staff'],
    rate_limit: 'global',
    request: { params: z.object({ macro_id: z.uuid() }) },
    responses: { 204: { description: 'Deleted' } },
    errors: ['SUPPORT_TICKETS_DISABLED', 'SUPPORT_MACRO_NOT_FOUND'],
    handler: async ({ ctx, identity, params }) => {
      ensureTickets(ctx.config.features.support.tickets.enabled);
      const result = await deleteMacro(ctx.db, {
        id: params.macro_id,
        actorId: signedIn(identity),
      });
      if (result.status === 'not_found') throw new ProblemError('SUPPORT_MACRO_NOT_FOUND');
      ctx.outbox.wake();
      return { status: 204 as const };
    },
  });

  router.route({
    method: 'GET',
    path: '/api/v1/admin/support/metrics',
    operation_id: 'supportMetrics',
    summary: 'Staff ticket metrics',
    tags: ['support'],
    auth: 'session',
    permissions: ['support.tickets.staff'],
    rate_limit: 'global',
    request: {
      query: z.object({
        since_days: z.coerce.number().int().min(1).max(365).default(30),
      }),
    },
    responses: { 200: { description: 'Aggregates', schema: metricsSchema } },
    handler: async ({ ctx, query }) => {
      ensureTickets(ctx.config.features.support.tickets.enabled);
      const since = new Date(Date.now() - query.since_days * 86_400_000);
      return { status: 200 as const, body: await staffMetricsSnapshot(ctx.db, { since }) };
    },
  });
}
