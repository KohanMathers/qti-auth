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
import { staffTicketUrl, ticketUrl } from './origin.ts';
import type { Context } from './service.ts';
import type { TicketRecord } from './tickets.ts';

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

export async function queueUserReply(ctx: Context, ticket: TicketRecord): Promise<void> {
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
