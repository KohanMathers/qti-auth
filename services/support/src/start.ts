import { consumeCron, pruneBusTables, RpcError, serveRpc } from '@qtiauth/bus';
import {
  type ObjectStore,
  type StartServiceOptions,
  type Stoppable,
  storageHealthCheck,
  unwind,
} from '@qtiauth/service-kit';
import * as z from 'zod';

import { loadCategories } from './categories.ts';
import type { Database } from './database.ts';
import { sweepGuestSecrets } from './guest.ts';
import { refreshOpenTickets, supportMetrics } from './metrics.ts';
import { queueNewTicketStaff, queueUserReminder, queueUserStatus } from './notify.ts';
import { type Context, type definition, router } from './service.ts';
import { openObjectStore } from './storage-state.ts';
import {
  CREATE_APPEAL_METHOD,
  createAppealTicket,
  eraseUserTickets,
  exportUserTickets,
  sweepAutoClose,
  sweepClosedTickets,
  USER_TICKETS_METHOD,
  userTickets,
} from './tickets.ts';

export const AUTO_CLOSE_JOB = 'support.auto_close';
export const RETENTION_JOB = 'retention.sweep';

export function supportService(options: { objectStore?: ObjectStore | null } = {}) {
  const storeOf = (ctx: Context) => openObjectStore(ctx, options.objectStore);
  return {
    router,
    readinessChecks: (ctx: Context) => {
      const store = storeOf(ctx);
      return store === null ? {} : { storage: storageHealthCheck(store) };
    },
    dataRights: (ctx: Context) => ({
      exportUser: async (userId) => ({
        tickets: await exportUserTickets(ctx.db, userId, storeOf(ctx)),
      }),
      eraseUser: async (userId, trx) => {
        await eraseUserTickets(trx, userId, storeOf(ctx));
      },
    }),
    start: async (ctx: Context) => {
      const { bus, db, log } = ctx;
      const stack: Stoppable[] = [];
      const store = storeOf(ctx);
      try {
        if (store !== null) {
          if (ctx.config.storage.enabled && ctx.config.storage.create_bucket)
            await store.ensureBucket();
          stack.push({ stop: () => store.close() });
        }
        stack.push(
          serveRpc(bus, {
            method: USER_TICKETS_METHOD,
            handler: async (request) => {
              const parsed = z.object({ user_id: z.uuid() }).safeParse(request);
              if (!parsed.success) throw new RpcError('bad_request', 'user_id is required');
              const listed = await userTickets(db, parsed.data.user_id);
              return {
                items: listed.items.map((ticket) => ({
                  id: ticket.id,
                  number: ticket.number,
                  subject: ticket.subject,
                  status: ticket.status,
                  category_id: ticket.category_id,
                  created_at: ticket.created_at.toISOString(),
                })),
              };
            },
            onError: (error) => {
              log.error('user tickets lookup failed', { error });
            },
          }),
        );

        stack.push(
          serveRpc(bus, {
            method: CREATE_APPEAL_METHOD,
            handler: async (request) => {
              const parsed = z
                .object({
                  user_id: z.uuid(),
                  action_id: z.uuid(),
                  body: z.string().min(1),
                })
                .safeParse(request);
              if (!parsed.success) {
                throw new RpcError('bad_request', 'user_id, action_id and body are required');
              }
              if (!ctx.config.features.support.tickets.enabled) {
                throw new RpcError('failed_precondition', 'Support tickets are not enabled');
              }
              const result = await createAppealTicket(db, {
                userId: parsed.data.user_id,
                actionId: parsed.data.action_id,
                body: parsed.data.body,
                categories: loadCategories(ctx.config.support),
                maxBody: ctx.config.support.max_body_length,
                now: new Date(),
              });
              if (result.status === 'too_long')
                throw new RpcError('bad_request', 'body is too long');
              if (result.status === 'unknown_category') {
                throw new RpcError('failed_precondition', 'No appeal category is configured');
              }
              if (result.status === 'ok') {
                ctx.outbox.wake();
                supportMetrics(ctx.metrics).created(result.ticket.category_id);
                await refreshOpenTickets(db, ctx.metrics, ctx.config.support);
                await queueNewTicketStaff(ctx, result.ticket, loadCategories(ctx.config.support));
              }
              return { ticket_id: result.ticket.id };
            },
            onError: (error) => {
              log.error('create appeal ticket failed', { error });
            },
          }),
        );

        stack.push(
          await consumeCron(bus, {
            job: AUTO_CLOSE_JOB,
            metrics: ctx.busMetrics,
            handler: async () => {
              const result = await sweepAutoClose(db, {
                autoCloseAfter: ctx.config.support.auto_close_after,
                now: new Date(),
              });
              const halfHours = Math.max(
                1,
                Math.round(ctx.config.support.auto_close_after / 2 / 3_600_000),
              );
              for (const ticket of result.reminded) {
                await queueUserReminder(ctx, ticket, halfHours);
              }
              for (const ticket of result.closed) {
                supportMetrics(ctx.metrics).autoClosed();
                const resolvedAt = ticket.resolved_at;
                if (resolvedAt !== null) {
                  supportMetrics(ctx.metrics).resolution(
                    (resolvedAt.getTime() - ticket.created_at.getTime()) / 1000,
                  );
                }
                await queueUserStatus(ctx, ticket);
              }
              if (result.reminded.length > 0 || result.closed.length > 0) ctx.outbox.wake();
              await refreshOpenTickets(db, ctx.metrics, ctx.config.support);
            },
            onError: (error) => {
              log.error('ticket auto-close failed', { error });
            },
          }),
        );

        stack.push(
          await consumeCron(bus, {
            job: RETENTION_JOB,
            metrics: ctx.busMetrics,
            handler: async () => {
              const now = new Date();
              const tickets = await sweepClosedTickets(db, {
                retention: ctx.config.retention.closed_tickets,
                now,
                store,
              });
              const secrets = await sweepGuestSecrets(db, {
                retention: ctx.config.retention.tokens,
                now,
              });
              const pruned = await pruneBusTables(db, ctx.config.bus);
              log.info('retention sweep finished', {
                tickets,
                guest_codes: secrets.codes,
                guest_links: secrets.links,
                guest_attempts: secrets.attempts,
                outbox: pruned.outbox,
                processed_events: pruned.processedEvents,
              });
            },
            onError: (error) => {
              log.error('retention sweep failed', { error });
            },
          }),
        );

        await refreshOpenTickets(db, ctx.metrics, ctx.config.support);
        log.info('support started', {
          categories: Object.keys(ctx.config.support.categories).length,
          tickets: ctx.config.features.support.tickets.enabled,
          guest_tickets: ctx.config.features.support.guest_tickets.enabled,
          attachments: ctx.config.features.support.attachments.enabled && store !== null,
        });
        return stack;
      } catch (error) {
        await unwind(stack.splice(0).map((task) => () => task.stop())).catch(
          (cleanupError: unknown) => {
            log.error('cleanup after failed start also failed', { error: cleanupError });
          },
        );
        throw error;
      }
    },
  } satisfies StartServiceOptions<typeof definition, Database>;
}
