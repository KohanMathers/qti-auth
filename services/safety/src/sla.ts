import { writeEvent } from '@qtiauth/bus';
import type { SafetyPriority } from '@qtiauth/config';
import { type Kysely, sql } from 'kysely';

import type { Database } from './database.ts';
import { reportSlaBreachedEvent, type ReportSlaBreachedData } from './events.ts';

export interface SlaBreach {
  reportId: string;
  type: string;
  priority: SafetyPriority;
  slaDeadline: Date;
  overdueBySeconds: number;
}

export async function sweepSlaBreaches(db: Kysely<Database>, now: Date): Promise<SlaBreach[]> {
  return db.transaction().execute(async (trx) => {
    const overdue = await trx
      .selectFrom('reports')
      .select(['id', 'type', 'priority', 'sla_deadline'])
      .where('status', 'in', ['open', 'triaged'])
      .where('sla_breach_notified_at', 'is', null)
      .where('sla_deadline', '<=', now)
      .forUpdate()
      .execute();
    const breaches: SlaBreach[] = [];
    for (const row of overdue) {
      const overdueMs = Math.max(0, now.getTime() - row.sla_deadline.getTime());
      const overdueBySeconds = Math.floor(overdueMs / 1000);
      const marked = await trx
        .updateTable('reports')
        .set({ sla_breach_notified_at: now, updated_at: now })
        .where('id', '=', row.id)
        .where('sla_breach_notified_at', 'is', null)
        .executeTakeFirst();
      if (Number(marked.numUpdatedRows) === 0) continue;
      await writeEvent<Database, ReportSlaBreachedData>(
        trx,
        reportSlaBreachedEvent(row.id, {
          report_id: row.id,
          type: row.type,
          priority: row.priority,
          sla_deadline: row.sla_deadline.toISOString(),
          overdue_by_seconds: overdueBySeconds,
        }),
      );
      breaches.push({
        reportId: row.id,
        type: row.type,
        priority: row.priority,
        slaDeadline: row.sla_deadline,
        overdueBySeconds,
      });
    }
    return breaches;
  });
}

export async function nextSlaDeadline(db: Kysely<Database>): Promise<Date | null> {
  const row = await sql<{ next_deadline: Date | null }>`
    select min(sla_deadline) as next_deadline
    from reports
    where status in ('open', 'triaged') and sla_breach_notified_at is null
  `.execute(db);
  return row.rows[0]?.next_deadline ?? null;
}
