import type { EmailCategory, EmailPriority } from '@qtiauth/email';
import { type Generated, type Kysely, sql } from 'kysely';

export const DELIVERY_STATUSES = ['retrying', 'sent', 'failed'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const MAX_ERROR_LENGTH = 1000;

export interface EmailDeliveriesTable {
  id: string;
  template: string;
  locale: string;
  category: EmailCategory;
  priority: EmailPriority;
  recipient: string;
  user_id: string | null;
  status: DeliveryStatus;
  attempts: number;
  provider: string;
  provider_message_id: string | null;
  last_error: string | null;
  queued_at: Date;
  sent_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface Database {
  email_deliveries: EmailDeliveriesTable;
}

export type DeliveryRecord = Omit<EmailDeliveriesTable, 'created_at' | 'updated_at'>;

export interface DeliveryLog {
  status: (id: string) => Promise<DeliveryStatus | null>;
  record: (delivery: DeliveryRecord) => Promise<void>;
}

export function errorSummary(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return message.slice(0, MAX_ERROR_LENGTH);
}

export function databaseDeliveryLog(db: Kysely<Database>): DeliveryLog {
  return {
    status: async (id) => {
      const row = await db
        .selectFrom('email_deliveries')
        .select('status')
        .where('id', '=', id)
        .executeTakeFirst();
      return row?.status ?? null;
    },
    record: async (delivery) => {
      await db
        .insertInto('email_deliveries')
        .values(delivery)
        .onConflict((conflict) =>
          conflict
            .column('id')
            .doUpdateSet((eb) => ({
              locale: eb.ref('excluded.locale'),
              status: eb.ref('excluded.status'),
              attempts: eb.ref('excluded.attempts'),
              provider: eb.ref('excluded.provider'),
              provider_message_id: eb.ref('excluded.provider_message_id'),
              last_error: eb.ref('excluded.last_error'),
              sent_at: eb.ref('excluded.sent_at'),
              updated_at: sql<Date>`now()`,
            }))
            .where('email_deliveries.status', '!=', 'sent'),
        )
        .execute();
    },
  };
}

export async function exportDeliveries(db: Kysely<Database>, userId: string) {
  const rows = await db
    .selectFrom('email_deliveries')
    .select(['id', 'template', 'locale', 'recipient', 'status', 'attempts', 'queued_at', 'sent_at'])
    .where('user_id', '=', userId)
    .orderBy('queued_at')
    .execute();
  return rows.map((row) => ({
    ...row,
    queued_at: row.queued_at.toISOString(),
    sent_at: row.sent_at?.toISOString() ?? null,
  }));
}

export async function eraseDeliveries(db: Kysely<Database>, userId: string): Promise<number> {
  const result = await db.deleteFrom('email_deliveries').where('user_id', '=', userId).execute();
  return result.reduce((total, row) => total + Number(row.numDeletedRows), 0);
}

export async function sweepDeliveries(db: Kysely<Database>, retention: number): Promise<number> {
  const result = await db
    .deleteFrom('email_deliveries')
    .where('created_at', '<', sql<Date>`now() - make_interval(secs => ${retention / 1000})`)
    .where('status', '!=', 'retrying')
    .execute();
  return result.reduce((total, row) => total + Number(row.numDeletedRows), 0);
}
