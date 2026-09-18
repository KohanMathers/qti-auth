import {
  createServiceRegistry,
  type DeclaredPermission,
  type DiscoveredService,
  type PermissionRegistry,
  type ServiceRegistry,
  startDiscovery,
} from '@qtiauth/service-kit';

import { contextAttachment } from './attachments.ts';
import type { Context } from './service.ts';

export const PERMISSION_REGISTRY_EXPIRY = 90_000;
export const PERMISSION_REGISTRY_INTERVAL = 30_000;

export interface ListedPermission extends DeclaredPermission {
  service: string;
}

export interface PermissionCatalog {
  list: () => ListedPermission[];
}

const attachment = contextAttachment<PermissionCatalog>();
export const attachPermissionCatalog = attachment.attach;
export const permissionCatalogOf = attachment.of;

export function mergeDeclaredPermissions(
  ownService: string,
  own: PermissionRegistry,
  discovered: readonly DiscoveredService[],
): ListedPermission[] {
  const byName = new Map<string, ListedPermission>();
  for (const permission of Object.values(own)) {
    byName.set(permission.name, { ...permission, service: ownService });
  }
  for (const service of discovered) {
    if (service.name === ownService) continue;
    for (const permission of service.manifest.permissions) {
      if (byName.has(permission.name)) continue;
      byName.set(permission.name, { ...permission, service: service.name });
    }
  }
  return [...byName.values()].toSorted((a, b) => a.name.localeCompare(b.name));
}

export function listedPermissions(ctx: Context): ListedPermission[] {
  return permissionCatalogOf(ctx)?.list() ?? [];
}

export function openPermissionCatalog(
  ctx: Context,
  own: PermissionRegistry,
): { registry: ServiceRegistry; stop: () => Promise<void> } {
  const registry = createServiceRegistry({ expiry: PERMISSION_REGISTRY_EXPIRY });
  const catalog: PermissionCatalog = {
    list: () => mergeDeclaredPermissions(ctx.service, own, registry.services()),
  };
  attachPermissionCatalog(ctx, catalog);
  const discovery = startDiscovery(ctx.bus, registry, {
    interval: PERMISSION_REGISTRY_INTERVAL,
    onChange: () => undefined,
    onInvalid: (error) => {
      ctx.log.warn('ignored an invalid service announcement', { error });
    },
  });
  return { registry, stop: () => discovery.stop() };
}
