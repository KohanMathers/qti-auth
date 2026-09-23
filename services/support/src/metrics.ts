import type { QtiauthConfig } from '@qtiauth/config';
import type { Metrics } from '@qtiauth/observability';
import type { Kysely } from 'kysely';

import { loadCategories } from './categories.ts';
import type { Database } from './database.ts';
import { countOpenByStatusAndCategory } from './tickets.ts';

export interface SupportMetrics {
  created: (category: string) => void;
  firstResponse: (seconds: number) => void;
  resolution: (seconds: number) => void;
  csat: (rating: number) => void;
  autoClosed: () => void;
  openTickets: (status: string, category: string, count: number) => void;
}

const created = new WeakMap<Metrics, SupportMetrics>();

export function supportMetrics(metrics: Metrics): SupportMetrics {
  let support = created.get(metrics);
  if (!support) {
    support = prometheusSupportMetrics(metrics);
    created.set(metrics, support);
  }
  return support;
}

function prometheusSupportMetrics(metrics: Metrics): SupportMetrics {
  const opened = metrics.counter({
    name: 'qtiauth_support_tickets_total',
    help: 'Support tickets opened, by category.',
    labelNames: ['category'],
  });
  const first = metrics.histogram({
    name: 'qtiauth_support_first_response_seconds',
    help: 'Seconds from ticket creation to the first staff reply.',
    buckets: [60, 300, 900, 3_600, 14_400, 86_400],
  });
  const resolved = metrics.histogram({
    name: 'qtiauth_support_resolution_seconds',
    help: 'Seconds from ticket creation to close.',
    buckets: [300, 900, 3_600, 14_400, 86_400, 604_800],
  });
  const ratings = metrics.counter({
    name: 'qtiauth_support_csat_total',
    help: 'Closed-ticket ratings from 1 to 5.',
    labelNames: ['rating'],
  });
  const auto = metrics.counter({
    name: 'qtiauth_support_auto_closes_total',
    help: 'Tickets closed by the waiting-on-user auto-close job.',
  });
  const open = metrics.gauge({
    name: 'qtiauth_support_tickets_open',
    help: 'Open and pending tickets, by status and category.',
    labelNames: ['status', 'category'],
  });
  return {
    created: (category) => {
      opened.inc({ category });
    },
    firstResponse: (seconds) => {
      first.observe(seconds);
    },
    resolution: (seconds) => {
      resolved.observe(seconds);
    },
    csat: (rating) => {
      ratings.inc({ rating: String(rating) });
    },
    autoClosed: () => {
      auto.inc();
    },
    openTickets: (status, category, count) => {
      open.set({ status, category }, count);
    },
  };
}

export async function refreshOpenTickets(
  db: Kysely<Database>,
  metrics: Metrics,
  config: QtiauthConfig['support'],
): Promise<void> {
  const categories = [...loadCategories(config).keys()];
  const counts = new Map(
    (await countOpenByStatusAndCategory(db)).map((row) => [
      `${row.status}:${row.category_id}`,
      row.count,
    ]),
  );
  const gauges = supportMetrics(metrics);
  for (const status of ['open', 'pending'] as const) {
    for (const category of categories) {
      gauges.openTickets(status, category, counts.get(`${status}:${category}`) ?? 0);
    }
  }
}
