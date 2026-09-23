import { ProblemError, type Router } from '@qtiauth/service-kit';
import * as z from 'zod';

import {
  addAttachment,
  getAttachment,
  presentedAttachment,
  signAttachmentDownload,
} from './attachments.ts';
import { clientIp, inspectCaptcha, requireCaptcha } from './captcha.ts';
import { loadCategories } from './categories.ts';
import { emailNormalizer } from './email.ts';
import {
  GUEST_ACTOR,
  GUEST_CODE,
  issueGuestCode,
  openGuestTicket,
  recordGuestAttempt,
  ticketForGuestToken,
} from './guest.ts';
import { refreshOpenTickets, supportMetrics } from './metrics.ts';
import {
  queueGuestCode,
  queueGuestOpened,
  queueNewTicketStaff,
  queueUserStatus,
} from './notify.ts';
import {
  attachmentStore,
  ensureTickets,
  NO_STORE,
  presentedTicket,
  userTicketDetail,
} from './routes.ts';
import type { Context } from './service.ts';
import {
  closeTicket,
  rateTicket,
  reopenTicket,
  replyToTicket,
  type TicketRecord,
} from './tickets.ts';

const captchaSchema = z
  .string()
  .min(1)
  .max(8192)
  .optional()
  .describe('CAPTCHA solution. Required after captcha.after guest-ticket starts from this IP.');

const codeBody = z.object({
  email: z.email().max(254),
  captcha: captchaSchema,
});

const guestTicketBody = z.object({
  email: z.email().max(254),
  code: z.string().regex(GUEST_CODE),
  category_id: z.string().min(1),
  subject: z.string().min(1),
  body: z.string().min(1),
});

const tokenBody = z.object({
  token: z.string().min(1),
});

const guestReplyBody = tokenBody.extend({
  body: z.string().min(1),
});

const guestRateBody = tokenBody.extend({
  rating: z.int().min(1).max(5),
});

const guestAttachmentBody = tokenBody.extend({
  filename: z.string().min(1).max(200),
  content: z.string().min(1).max(70_000_000),
});

const guestDownloadBody = tokenBody.extend({
  attachment_id: z.uuid(),
});

const openedSchema = z.object({ number: z.int() });

const categorySchema = z.object({
  id: z.string(),
  name: z.string(),
  guest_allowed: z.boolean(),
  appeal: z.boolean(),
});

const attachmentSchema = z.object({
  id: z.uuid(),
  filename: z.string(),
  content_type: z.string(),
  size_bytes: z.int(),
  created_at: z.iso.datetime(),
});

const downloadSchema = z.object({
  url: z.string(),
  expires_at: z.iso.datetime(),
});

function ensureGuest(ctx: Context): void {
  ensureTickets(ctx.config.features.support.tickets.enabled);
  if (!ctx.config.features.support.guest_tickets.enabled) {
    throw new ProblemError('SUPPORT_GUEST_DISABLED');
  }
}

async function guestTicket(ctx: Context, token: string): Promise<TicketRecord> {
  const ticket = await ticketForGuestToken(ctx.db, token, new Date());
  if (ticket?.guest_email == null) throw new ProblemError('SUPPORT_GUEST_LINK_INVALID');
  return ticket;
}

const GUEST_ERRORS = [
  'SUPPORT_TICKETS_DISABLED',
  'SUPPORT_GUEST_DISABLED',
  'SUPPORT_GUEST_LINK_INVALID',
] as const;

export function guestRoutes(router: Router<Context>): void {
  router.route({
    method: 'GET',
    path: '/api/v1/support/guest/categories',
    operation_id: 'listGuestTicketCategories',
    summary: 'Categories a signed-out person can use',
    tags: ['support'],
    auth: 'none',
    rate_limit: 'global',
    responses: {
      200: {
        description: 'Guest-allowed categories',
        schema: z.object({ items: z.array(categorySchema) }),
      },
    },
    errors: ['SUPPORT_TICKETS_DISABLED', 'SUPPORT_GUEST_DISABLED'],
    handler: ({ ctx }) => {
      ensureGuest(ctx);
      const items = [...loadCategories(ctx.config.support).values()].filter(
        (category) => category.guest_allowed && !category.appeal,
      );
      return Promise.resolve({ status: 200 as const, body: { items } });
    },
  });

  router.route({
    method: 'GET',
    path: '/api/v1/support/guest/captcha',
    operation_id: 'getGuestCaptcha',
    summary: 'Whether a CAPTCHA is required before emailing a guest-ticket code',
    tags: ['support'],
    auth: 'none',
    rate_limit: 'global',
    responses: {
      200: {
        description: 'Whether a CAPTCHA is required, and how to solve it',
        schema: z.object({
          required: z.boolean(),
          provider: z.string(),
          site_key: z.string().nullable(),
          challenge: z
            .object({
              algorithm: z.string(),
              challenge: z.string(),
              salt: z.string(),
              signature: z.string(),
              maxnumber: z.number(),
            })
            .nullable(),
        }),
      },
    },
    errors: ['SUPPORT_TICKETS_DISABLED', 'SUPPORT_GUEST_DISABLED'],
    handler: async ({ ctx, request }) => {
      ensureGuest(ctx);
      return { status: 200, headers: NO_STORE, body: await inspectCaptcha(ctx, request) };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/support/guest/codes',
    operation_id: 'startGuestTicket',
    summary: 'Email a code for opening a guest ticket',
    description:
      'Always answers the same way. A CAPTCHA is required after captcha.after starts from this IP. The route is limited by the guest_ticket policy.',
    tags: ['support'],
    auth: 'none',
    rate_limit: 'guest_ticket',
    request: { body: codeBody },
    responses: {
      202: {
        description: 'The code is on its way',
        schema: z.object({ status: z.literal('sent') }),
      },
    },
    errors: [
      'SUPPORT_TICKETS_DISABLED',
      'SUPPORT_GUEST_DISABLED',
      'SUPPORT_CAPTCHA_REQUIRED',
      'SUPPORT_CAPTCHA_INVALID',
    ],
    handler: async ({ ctx, body, request }) => {
      ensureGuest(ctx);
      await requireCaptcha(ctx, request, body.captcha);
      const email = body.email.trim();
      const code = await issueGuestCode(ctx.db, {
        email,
        emailNormalized: emailNormalizer(ctx.config.accounts.email_normalization)(email),
        ttl: ctx.config.support.guest_code_ttl,
        now: new Date(),
      });
      await queueGuestCode(ctx, email, code);
      await recordGuestAttempt(ctx.db, { ip: clientIp(request), now: new Date() });
      return { status: 202 as const, headers: NO_STORE, body: { status: 'sent' as const } };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/support/guest/tickets',
    operation_id: 'createGuestTicket',
    summary: 'Open a guest ticket with an emailed code',
    description:
      'The category must be guest-allowed. A magic link for following the ticket is emailed; it is not in this response.',
    tags: ['support'],
    auth: 'none',
    rate_limit: 'guest_ticket',
    request: { body: guestTicketBody },
    responses: { 201: { description: 'The ticket number', schema: openedSchema } },
    errors: [
      'SUPPORT_TICKETS_DISABLED',
      'SUPPORT_GUEST_DISABLED',
      'SUPPORT_CATEGORY_UNKNOWN',
      'SUPPORT_CATEGORY_GUEST',
      'SUPPORT_GUEST_CODE_INVALID',
      'SUPPORT_TICKET_INVALID',
    ],
    handler: async ({ ctx, body }) => {
      ensureGuest(ctx);
      const email = body.email.trim();
      const result = await openGuestTicket(ctx.db, {
        email,
        emailNormalized: emailNormalizer(ctx.config.accounts.email_normalization)(email),
        code: body.code,
        categoryId: body.category_id,
        subject: body.subject,
        body: body.body,
        categories: loadCategories(ctx.config.support),
        maxSubject: ctx.config.support.max_subject_length,
        maxBody: ctx.config.support.max_body_length,
        linkTtl: ctx.config.support.guest_link_ttl,
        now: new Date(),
      });
      if (result.status === 'too_long') throw new ProblemError('SUPPORT_TICKET_INVALID');
      if (result.status === 'unknown_category') throw new ProblemError('SUPPORT_CATEGORY_UNKNOWN');
      if (result.status === 'guest_category') throw new ProblemError('SUPPORT_CATEGORY_GUEST');
      if (result.status === 'invalid_code') throw new ProblemError('SUPPORT_GUEST_CODE_INVALID');
      ctx.outbox.wake();
      supportMetrics(ctx.metrics).created(result.ticket.category_id);
      supportMetrics(ctx.metrics).guest();
      await refreshOpenTickets(ctx.db, ctx.metrics, ctx.config.support);
      await queueNewTicketStaff(ctx, result.ticket, loadCategories(ctx.config.support));
      await queueGuestOpened(ctx, result.ticket, result.token);
      return { status: 201 as const, body: { number: result.ticket.number } };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/support/guest/tickets/view',
    operation_id: 'viewGuestTicket',
    summary: 'Read a guest ticket with its magic-link token',
    tags: ['support'],
    auth: 'none',
    rate_limit: 'global',
    request: { body: tokenBody },
    responses: {
      200: {
        description: 'The ticket',
        schema: z.object({
          id: z.uuid(),
          number: z.int(),
          category_id: z.string(),
          subject: z.string(),
          status: z.string(),
          priority: z.string(),
          appeal: z.boolean(),
          action_id: z.uuid().nullable(),
          rating: z.int().nullable(),
          created_at: z.iso.datetime(),
          resolved_at: z.iso.datetime().nullable(),
          messages: z.array(
            z.object({
              id: z.uuid(),
              staff: z.boolean(),
              body: z.string(),
              created_at: z.iso.datetime(),
            }),
          ),
          attachments: z.array(attachmentSchema),
        }),
      },
    },
    errors: [...GUEST_ERRORS],
    handler: async ({ ctx, body }) => {
      ensureGuest(ctx);
      const ticket = await guestTicket(ctx, body.token);
      return { status: 200, headers: NO_STORE, body: await userTicketDetail(ctx, ticket) };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/support/guest/tickets/replies',
    operation_id: 'replyToGuestTicket',
    summary: 'Reply to a guest ticket',
    tags: ['support'],
    auth: 'none',
    rate_limit: 'global',
    request: { body: guestReplyBody },
    responses: { 200: { description: 'The ticket number', schema: openedSchema } },
    errors: [...GUEST_ERRORS, 'SUPPORT_TICKET_CLOSED', 'SUPPORT_TICKET_INVALID'],
    handler: async ({ ctx, body }) => {
      ensureGuest(ctx);
      const ticket = await guestTicket(ctx, body.token);
      const result = await replyToTicket(ctx.db, {
        ticketId: ticket.id,
        authorId: null,
        staff: false,
        body: body.body,
        maxBody: ctx.config.support.max_body_length,
        now: new Date(),
      });
      if (result.status === 'not_found') throw new ProblemError('SUPPORT_GUEST_LINK_INVALID');
      if (result.status === 'closed') throw new ProblemError('SUPPORT_TICKET_CLOSED');
      if (result.status === 'too_long') throw new ProblemError('SUPPORT_TICKET_INVALID');
      ctx.outbox.wake();
      await refreshOpenTickets(ctx.db, ctx.metrics, ctx.config.support);
      return { status: 200 as const, body: { number: result.ticket.number } };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/support/guest/tickets/close',
    operation_id: 'closeGuestTicket',
    summary: 'Close a guest ticket',
    tags: ['support'],
    auth: 'none',
    rate_limit: 'global',
    request: { body: tokenBody },
    responses: {
      200: { description: 'The ticket', schema: z.object({ number: z.int(), status: z.string() }) },
    },
    errors: [...GUEST_ERRORS, 'SUPPORT_TICKET_CLOSED'],
    handler: async ({ ctx, body }) => {
      ensureGuest(ctx);
      const ticket = await guestTicket(ctx, body.token);
      const result = await closeTicket(ctx.db, {
        ticketId: ticket.id,
        actor: GUEST_ACTOR,
        now: new Date(),
      });
      if (result.status === 'not_found') throw new ProblemError('SUPPORT_GUEST_LINK_INVALID');
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
      return {
        status: 200 as const,
        body: { number: result.ticket.number, status: result.ticket.status },
      };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/support/guest/tickets/reopen',
    operation_id: 'reopenGuestTicket',
    summary: 'Reopen a guest ticket',
    tags: ['support'],
    auth: 'none',
    rate_limit: 'global',
    request: { body: tokenBody },
    responses: {
      200: { description: 'The ticket', schema: z.object({ number: z.int(), status: z.string() }) },
    },
    errors: [...GUEST_ERRORS, 'SUPPORT_TICKET_OPEN'],
    handler: async ({ ctx, body }) => {
      ensureGuest(ctx);
      const ticket = await guestTicket(ctx, body.token);
      const result = await reopenTicket(ctx.db, {
        ticketId: ticket.id,
        actor: GUEST_ACTOR,
        now: new Date(),
      });
      if (result.status === 'not_found') throw new ProblemError('SUPPORT_GUEST_LINK_INVALID');
      if (result.status === 'open') throw new ProblemError('SUPPORT_TICKET_OPEN');
      ctx.outbox.wake();
      await refreshOpenTickets(ctx.db, ctx.metrics, ctx.config.support);
      await queueUserStatus(ctx, result.ticket);
      return {
        status: 200 as const,
        body: { number: result.ticket.number, status: result.ticket.status },
      };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/support/guest/tickets/rate',
    operation_id: 'rateGuestTicket',
    summary: 'Rate a closed guest ticket',
    tags: ['support'],
    auth: 'none',
    rate_limit: 'global',
    request: { body: guestRateBody },
    responses: { 200: { description: 'The ticket', schema: presentedTicketSchema() } },
    errors: [...GUEST_ERRORS, 'SUPPORT_TICKET_OPEN', 'SUPPORT_TICKET_RATED'],
    handler: async ({ ctx, body }) => {
      ensureGuest(ctx);
      const ticket = await guestTicket(ctx, body.token);
      const result = await rateTicket(ctx.db, {
        ticketId: ticket.id,
        userId: null,
        rating: body.rating,
        guest: true,
        now: new Date(),
      });
      if (result.status === 'not_found') throw new ProblemError('SUPPORT_GUEST_LINK_INVALID');
      if (result.status === 'open') throw new ProblemError('SUPPORT_TICKET_OPEN');
      if (result.status === 'rated') throw new ProblemError('SUPPORT_TICKET_RATED');
      supportMetrics(ctx.metrics).csat(body.rating);
      return { status: 200 as const, body: presentedTicket(result.ticket) };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/support/guest/attachments',
    operation_id: 'addGuestAttachment',
    summary: 'Attach a file to a guest ticket',
    tags: ['support'],
    auth: 'none',
    rate_limit: 'global',
    request: { body: guestAttachmentBody },
    responses: { 201: { description: 'The attachment', schema: attachmentSchema } },
    errors: [
      ...GUEST_ERRORS,
      'SUPPORT_ATTACHMENTS_DISABLED',
      'SUPPORT_STORAGE_UNAVAILABLE',
      'SUPPORT_TICKET_CLOSED',
      'SUPPORT_ATTACHMENT_INVALID',
    ],
    handler: async ({ ctx, body }) => {
      ensureGuest(ctx);
      const store = attachmentStore(ctx);
      const ticket = await guestTicket(ctx, body.token);
      const result = await addAttachment(ctx.db, store, {
        ticketId: ticket.id,
        filename: body.filename,
        content: body.content,
        maxBytes: ctx.config.support.attachment_max_bytes,
        now: new Date(),
      });
      if (result.status === 'not_found') throw new ProblemError('SUPPORT_GUEST_LINK_INVALID');
      if (result.status === 'closed') throw new ProblemError('SUPPORT_TICKET_CLOSED');
      if (result.status === 'invalid') throw new ProblemError('SUPPORT_ATTACHMENT_INVALID');
      return { status: 201 as const, body: presentedAttachment(result.attachment) };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/support/guest/attachments/download',
    operation_id: 'downloadGuestAttachment',
    summary: 'Signed download URL for a guest attachment',
    tags: ['support'],
    auth: 'none',
    rate_limit: 'global',
    request: { body: guestDownloadBody },
    responses: { 200: { description: 'A short-lived download URL', schema: downloadSchema } },
    errors: [
      ...GUEST_ERRORS,
      'SUPPORT_ATTACHMENTS_DISABLED',
      'SUPPORT_STORAGE_UNAVAILABLE',
      'SUPPORT_ATTACHMENT_NOT_FOUND',
    ],
    handler: async ({ ctx, body }) => {
      ensureGuest(ctx);
      const store = attachmentStore(ctx);
      const ticket = await guestTicket(ctx, body.token);
      const attachment = await getAttachment(ctx.db, body.attachment_id);
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

function presentedTicketSchema() {
  return z.object({
    id: z.uuid(),
    number: z.int(),
    category_id: z.string(),
    subject: z.string(),
    status: z.string(),
    priority: z.string(),
    appeal: z.boolean(),
    action_id: z.uuid().nullable(),
    rating: z.int().nullable(),
    created_at: z.iso.datetime(),
    resolved_at: z.iso.datetime().nullable(),
  });
}
