import { writeEvent } from '@qtiauth/bus';
import {
  type DeclaredNotification,
  defineNotificationCategories,
  type NotificationAudience,
} from '@qtiauth/service-kit';
import type { Kysely } from 'kysely';

import type { Database } from './database.ts';
import { type UserUpdatedData, userUpdatedEvent } from './events.ts';

export const IDENTITY_NOTIFICATIONS = defineNotificationCategories({
  'identity.security': {
    description:
      'Security emails such as password resets, new-device notices and data-export links',
    disableable: false,
  },
  'identity.legal': {
    description: 'Legal document updates',
    disableable: false,
  },
  'support.ticket_updates': {
    description: 'Replies and status changes on your support tickets',
  },
  'support.new_tickets': {
    description: 'A new support ticket was opened',
    audience: 'staff',
  },
  'safety.high_priority_reports': {
    description: 'A high-priority safety report was filed',
    audience: 'staff',
  },
});

export interface NotificationPreference {
  user_id: string;
  category: string;
  enabled: boolean;
  updated_at: Date;
}

export interface PresentedNotification {
  id: string;
  description: string;
  audience: NotificationAudience;
  disableable: boolean;
  enabled: boolean;
  service: string;
}

export type SetPreferencesResult =
  | { status: 'ok'; categories: PresentedNotification[] }
  | { status: 'unknown'; id: string }
  | { status: 'required'; id: string };

function visibleCategories(
  catalog: readonly (DeclaredNotification & { service: string })[],
  staff: boolean,
): (DeclaredNotification & { service: string })[] {
  return catalog.filter((category) => category.audience === 'user' || staff);
}

export async function listPreferences(
  db: Kysely<Database>,
  options: {
    userId: string;
    catalog: readonly (DeclaredNotification & { service: string })[];
    staff: boolean;
  },
): Promise<PresentedNotification[]> {
  const visible = visibleCategories(options.catalog, options.staff);
  if (visible.length === 0) return [];
  const rows = await db
    .selectFrom('notification_preferences')
    .select(['category', 'enabled'])
    .where('user_id', '=', options.userId)
    .where(
      'category',
      'in',
      visible.map((category) => category.name),
    )
    .execute();
  const enabled = new Map(rows.map((row) => [row.category, row.enabled]));
  return visible.map((category) => ({
    id: category.name,
    description: category.description,
    audience: category.audience,
    disableable: category.disableable,
    enabled: enabled.get(category.name) ?? true,
    service: category.service,
  }));
}

export async function notificationAllowed(
  db: Kysely<Database>,
  options: {
    userId: string;
    category: string;
    catalog: readonly DeclaredNotification[];
  },
): Promise<boolean> {
  const declared = options.catalog.find((category) => category.name === options.category);
  if (!declared?.disableable) return true;
  const row = await db
    .selectFrom('notification_preferences')
    .select('enabled')
    .where('user_id', '=', options.userId)
    .where('category', '=', options.category)
    .executeTakeFirst();
  return row?.enabled ?? true;
}

export async function setPreferences(
  db: Kysely<Database>,
  options: {
    userId: string;
    catalog: readonly (DeclaredNotification & { service: string })[];
    staff: boolean;
    updates: readonly { id: string; enabled: boolean }[];
    now: Date;
  },
): Promise<SetPreferencesResult> {
  const visible = new Map(
    visibleCategories(options.catalog, options.staff).map((category) => [category.name, category]),
  );

  for (const update of options.updates) {
    const declared = visible.get(update.id);
    if (declared === undefined) return { status: 'unknown', id: update.id };
    if (!declared.disableable && !update.enabled) return { status: 'required', id: update.id };
  }

  return db.transaction().execute(async (trx) => {
    const existing = await trx
      .selectFrom('notification_preferences')
      .select(['category', 'enabled'])
      .where('user_id', '=', options.userId)
      .execute();
    const current = new Map(existing.map((row) => [row.category, row.enabled]));
    const changed = options.updates.filter(
      (update) => (current.get(update.id) ?? true) !== update.enabled,
    );
    if (changed.length > 0) {
      for (const update of changed) {
        await trx
          .insertInto('notification_preferences')
          .values({
            user_id: options.userId,
            category: update.id,
            enabled: update.enabled,
            updated_at: options.now,
          })
          .onConflict((conflict) =>
            conflict.columns(['user_id', 'category']).doUpdateSet({
              enabled: update.enabled,
              updated_at: options.now,
            }),
          )
          .execute();
      }
      await writeEvent<Database, UserUpdatedData>(
        trx,
        userUpdatedEvent(options.userId, { fields: ['notifications'] }),
      );
    }
    return {
      status: 'ok' as const,
      categories: await listPreferences(trx, {
        userId: options.userId,
        catalog: options.catalog,
        staff: options.staff,
      }),
    };
  });
}

export async function listStoredPreferences(
  db: Kysely<Database>,
  userId: string,
): Promise<NotificationPreference[]> {
  return db
    .selectFrom('notification_preferences')
    .select(['user_id', 'category', 'enabled', 'updated_at'])
    .where('user_id', '=', userId)
    .orderBy('category')
    .execute();
}
