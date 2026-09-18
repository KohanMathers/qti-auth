import {
  type DeclaredNotification,
  type DiscoveredService,
  type NotificationRegistry,
  type ServiceRegistry,
} from '@qtiauth/service-kit';

import { contextAttachment } from './attachments.ts';
import { IDENTITY_NOTIFICATIONS } from './notifications.ts';
import type { Context } from './service.ts';

export interface ListedNotification extends DeclaredNotification {
  service: string;
}

export interface NotificationCatalog {
  list: () => ListedNotification[];
}

const attachment = contextAttachment<NotificationCatalog>();
export const attachNotificationCatalog = attachment.attach;
export const notificationCatalogOf = attachment.of;

export function mergeDeclaredNotifications(
  ownService: string,
  own: NotificationRegistry,
  discovered: readonly DiscoveredService[],
): ListedNotification[] {
  const byName = new Map<string, ListedNotification>();
  for (const category of Object.values(own)) {
    byName.set(category.name, { ...category, service: ownService });
  }
  for (const service of discovered) {
    if (service.name === ownService) continue;
    for (const category of service.manifest.notifications) {
      if (byName.has(category.name)) continue;
      byName.set(category.name, { ...category, service: service.name });
    }
  }
  return [...byName.values()].toSorted((a, b) => a.name.localeCompare(b.name));
}

export function listedNotifications(ctx: Context): ListedNotification[] {
  return (
    notificationCatalogOf(ctx)?.list() ??
    mergeDeclaredNotifications(ctx.service, IDENTITY_NOTIFICATIONS, [])
  );
}

export function openNotificationCatalog(
  ctx: Context,
  own: NotificationRegistry,
  registry: ServiceRegistry,
): void {
  attachNotificationCatalog(ctx, {
    list: () => mergeDeclaredNotifications(ctx.service, own, registry.services()),
  });
}
