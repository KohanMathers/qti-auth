import { rpcRequest } from '@qtiauth/bus';
import { queueEmail } from '@qtiauth/email';
import {
  NOTIFICATION_ALLOWED_METHOD,
  NOTIFICATION_ALLOWED_SERVICE,
  STAFF_ALERT_RECIPIENTS_METHOD,
  STAFF_ALERT_RECIPIENTS_SERVICE,
  type StaffAlertRecipientsResponse,
  USER_CLAIMS_METHOD,
  USER_CLAIMS_SERVICE,
  type UserClaimsResponse,
} from '@qtiauth/service-kit';

import { categoryOf, type TicketCategory } from './categories.ts';
import type { TicketStatus } from './database.ts';
import { issueGuestLink } from './guest.ts';
import { guestTicketUrl, staffTicketUrl, ticketUrl } from './origin.ts';
import type { Context } from './service.ts';
import type { TicketRecord } from './tickets.ts';

function wholeMinutes(ms: number): number {
  return Math.max(1, Math.round(ms / 60_000));
}

function wholeDays(ms: number): number {
  return Math.max(1, Math.ceil(ms / 86_400_000));
}

async function guestLink(ctx: Context, ticket: TicketRecord): Promise<string | undefined> {
  if (ticket.guest_email === null) return undefined;
  const token = await issueGuestLink(ctx.db, {
    ticketId: ticket.id,
    ttl: ctx.config.support.guest_link_ttl,
    now: new Date(),
  });
  return guestTicketUrl(ctx.config.surfaces, token);
}

async function userEmail(ctx: Context, userId: string): Promise<string | null> {
  const result = await rpcRequest<UserClaimsResponse>(
    ctx.bus,
    USER_CLAIMS_SERVICE,
    USER_CLAIMS_METHOD,
    { user_id: userId },
  );
  if (result.status !== 'ok' || result.data.user === null) return null;
  return result.data.user.email;
}

async function ticketUpdatesAllowed(ctx: Context, userId: string): Promise<boolean> {
  const result = await rpcRequest<{ allowed: boolean }>(
    ctx.bus,
    NOTIFICATION_ALLOWED_SERVICE,
    NOTIFICATION_ALLOWED_METHOD,
    { user_id: userId, category: 'support.ticket_updates' },
  );
  return result.status !== 'ok' || result.data.allowed;
}

export async function queueNewTicketStaff(
  ctx: Context,
  ticket: TicketRecord,
  categories: Map<string, TicketCategory>,
): Promise<void> {
  const link = staffTicketUrl(ctx.config.surfaces, ticket.id);
  if (link === undefined) return;
  const result = await rpcRequest<StaffAlertRecipientsResponse>(
    ctx.bus,
    STAFF_ALERT_RECIPIENTS_SERVICE,
    STAFF_ALERT_RECIPIENTS_METHOD,
    { category: 'support.new_tickets' },
  );
  if (result.status !== 'ok') return;
  const category = categoryOf(categories, ticket.category_id)?.name ?? ticket.category_id;
  for (const recipient of result.data.recipients) {
    await queueEmail(ctx.bus, {
      template: 'ticket_opened_staff',
      to: { address: recipient.email },
      locale: recipient.locale ?? ctx.config.email.default_locale,
      userId: recipient.user_id,
      variables: { number: ticket.number, category, link },
    });
  }
}

export async function queueGuestOpened(
  ctx: Context,
  ticket: TicketRecord,
  token: string,
): Promise<void> {
  if (ticket.guest_email === null) return;
  const link = guestTicketUrl(ctx.config.surfaces, token);
  if (link === undefined) return;
  await queueEmail(ctx.bus, {
    template: 'guest_ticket',
    to: { address: ticket.guest_email },
    locale: ctx.config.email.default_locale,
    variables: {
      number: ticket.number,
      link,
      expires_in_days: wholeDays(ctx.config.support.guest_link_ttl),
    },
  });
}

export async function queueGuestCode(ctx: Context, email: string, code: string): Promise<void> {
  await queueEmail(ctx.bus, {
    template: 'guest_code',
    to: { address: email },
    locale: ctx.config.email.default_locale,
    variables: {
      code,
      expires_in_minutes: wholeMinutes(ctx.config.support.guest_code_ttl),
    },
  });
}

export async function queueUserReply(ctx: Context, ticket: TicketRecord): Promise<void> {
  if (ticket.guest_email !== null) {
    const link = await guestLink(ctx, ticket);
    if (link === undefined) return;
    await queueEmail(ctx.bus, {
      template: 'ticket_reply',
      to: { address: ticket.guest_email },
      locale: ctx.config.email.default_locale,
      variables: { number: ticket.number, link },
    });
    return;
  }
  if (ticket.user_id === null) return;
  if (!(await ticketUpdatesAllowed(ctx, ticket.user_id))) return;
  const link = ticketUrl(ctx.config.surfaces, ticket.id);
  if (link === undefined) return;
  const address = await userEmail(ctx, ticket.user_id);
  if (address === null) return;
  await queueEmail(ctx.bus, {
    template: 'ticket_reply',
    to: { address },
    locale: ctx.config.email.default_locale,
    userId: ticket.user_id,
    variables: { number: ticket.number, link },
  });
}

const STATUS_LABEL: Record<TicketStatus, string> = {
  open: 'open',
  pending: 'waiting for you',
  closed: 'closed',
};

export async function queueUserStatus(ctx: Context, ticket: TicketRecord): Promise<void> {
  if (ticket.guest_email !== null) {
    const link = await guestLink(ctx, ticket);
    if (link === undefined) return;
    await queueEmail(ctx.bus, {
      template: 'ticket_status',
      to: { address: ticket.guest_email },
      locale: ctx.config.email.default_locale,
      variables: { number: ticket.number, status: STATUS_LABEL[ticket.status], link },
    });
    return;
  }
  if (ticket.user_id === null) return;
  if (!(await ticketUpdatesAllowed(ctx, ticket.user_id))) return;
  const link = ticketUrl(ctx.config.surfaces, ticket.id);
  if (link === undefined) return;
  const address = await userEmail(ctx, ticket.user_id);
  if (address === null) return;
  await queueEmail(ctx.bus, {
    template: 'ticket_status',
    to: { address },
    locale: ctx.config.email.default_locale,
    userId: ticket.user_id,
    variables: { number: ticket.number, status: STATUS_LABEL[ticket.status], link },
  });
}

export async function queueUserReminder(
  ctx: Context,
  ticket: TicketRecord,
  closesInHours: number,
): Promise<void> {
  if (ticket.guest_email !== null) {
    const link = await guestLink(ctx, ticket);
    if (link === undefined) return;
    await queueEmail(ctx.bus, {
      template: 'ticket_reminder',
      to: { address: ticket.guest_email },
      locale: ctx.config.email.default_locale,
      variables: {
        number: ticket.number,
        closes_in_hours: Math.max(1, closesInHours),
        link,
      },
    });
    return;
  }
  if (ticket.user_id === null) return;
  if (!(await ticketUpdatesAllowed(ctx, ticket.user_id))) return;
  const link = ticketUrl(ctx.config.surfaces, ticket.id);
  if (link === undefined) return;
  const address = await userEmail(ctx, ticket.user_id);
  if (address === null) return;
  await queueEmail(ctx.bus, {
    template: 'ticket_reminder',
    to: { address },
    locale: ctx.config.email.default_locale,
    userId: ticket.user_id,
    variables: {
      number: ticket.number,
      closes_in_hours: Math.max(1, closesInHours),
      link,
    },
  });
}
