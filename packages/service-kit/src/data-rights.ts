import {
  type Bus,
  type BusMetrics,
  consumeEvents,
  InvalidMessageError,
  type MessageContext,
  type RpcContext,
  RpcError,
  type RpcServer,
  serveRpc,
} from '@qtiauth/bus';
import type { EventEnvelope } from '@qtiauth/events';
import type { Kysely, Transaction } from 'kysely';
import * as z from 'zod';

export const EXPORT_USER_METHOD = 'export_user';
export const USER_DELETED_EVENT = 'qtiauth.identity.user.deleted.v1';
export const ERASURE_CONSUMER = 'user_erasure';

export interface ExportUserRequest {
  user_id: string;
}

export interface UserExport {
  service: string;
  data: Record<string, unknown>;
}

export interface DataRightsHandlers<DB> {
  exportUser: (userId: string, context: RpcContext) => Promise<Record<string, unknown>>;
  eraseUser: (userId: string, trx: Transaction<DB>, event: EventEnvelope) => Promise<void>;
}

export interface DataRightsOptions {
  onError: (error: unknown, context: RpcContext | MessageContext) => void;
  metrics?: BusMetrics;
}

export interface DataRights {
  stop: () => Promise<void>;
}

const exportRequestSchema = z.object({ user_id: z.uuid() });

export async function registerDataRights<DB>(
  bus: Bus,
  db: Kysely<DB>,
  handlers: DataRightsHandlers<DB>,
  options: DataRightsOptions,
): Promise<DataRights> {
  const exporter: RpcServer = serveRpc<unknown, UserExport>(bus, {
    method: EXPORT_USER_METHOD,
    handler: async (request, context) => {
      const parsed = exportRequestSchema.safeParse(request);
      if (!parsed.success) throw new RpcError('bad_request', 'user_id must be a UUID');
      return {
        service: bus.service,
        data: await handlers.exportUser(parsed.data.user_id, context),
      };
    },
    onError: options.onError,
  });

  try {
    const eraser = await consumeEvents<DB>(bus, db, {
      name: ERASURE_CONSUMER,
      types: [USER_DELETED_EVENT],
      startFrom: 'all',
      handler: async (event, trx) => {
        if (event.subject?.type !== 'user') {
          throw new InvalidMessageError(`${USER_DELETED_EVENT} must have a user subject`);
        }
        await handlers.eraseUser(event.subject.id, trx, event);
      },
      onError: options.onError,
      ...(options.metrics === undefined ? {} : { metrics: options.metrics }),
    });
    return {
      stop: async () => {
        await Promise.all([exporter.stop(), eraser.stop()]);
      },
    };
  } catch (error) {
    await exporter.stop();
    throw error;
  }
}
