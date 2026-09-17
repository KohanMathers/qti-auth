import type { Bus } from '@qtiauth/bus';
import {
  ANNOUNCE_SUBJECT,
  DISCOVER_SUBJECT,
  type RouteManifest,
  type ServiceAnnouncement,
  serviceAnnouncementSchema,
} from '@qtiauth/service-kit';

export interface RunningService {
  name: string;
  version: string;
  instances: number;
  manifest: RouteManifest;
}

export interface ServiceRegistry {
  announce: (announcement: ServiceAnnouncement) => boolean;
  expire: () => boolean;
  services: () => RunningService[];
  isRunning: (service: string) => boolean;
}

export interface RegistryOptions {
  expiry: number;
  now?: () => number;
}

export interface DiscoveryOptions {
  interval: number;
  onChange: () => void;
  onInvalid: (error: unknown) => void;
}

export interface Discovery {
  stop: () => Promise<void>;
}

export function createServiceRegistry(options: RegistryOptions): ServiceRegistry {
  const now = options.now ?? Date.now;
  const instances = new Map<string, { announcement: ServiceAnnouncement; seenAt: number }>();

  const services = (): RunningService[] => {
    const byService = new Map<string, ServiceAnnouncement[]>();
    for (const { announcement } of instances.values()) {
      byService.set(announcement.service, [
        ...(byService.get(announcement.service) ?? []),
        announcement,
      ]);
    }
    return [...byService.entries()]
      .map(([name, announcements]) => {
        const latest = announcements.reduce((a, b) =>
          Date.parse(b.started_at) > Date.parse(a.started_at) ? b : a,
        );
        return {
          name,
          version: latest.version,
          instances: announcements.length,
          manifest: latest.manifest,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  };

  return {
    announce: (announcement) => {
      const before = JSON.stringify(services());
      instances.set(announcement.instance_id, { announcement, seenAt: now() });
      return JSON.stringify(services()) !== before;
    },
    expire: () => {
      let changed = false;
      for (const [id, instance] of instances) {
        if (now() - instance.seenAt > options.expiry) {
          instances.delete(id);
          changed = true;
        }
      }
      return changed;
    },
    services,
    isRunning: (service) =>
      [...instances.values()].some(({ announcement }) => announcement.service === service),
  };
}

export function startDiscovery(
  bus: Bus,
  registry: ServiceRegistry,
  options: DiscoveryOptions,
): Discovery {
  const sub = bus.nc.subscribe(ANNOUNCE_SUBJECT, {
    callback: (error, msg) => {
      if (error) {
        options.onInvalid(error);
        return;
      }
      let parsed;
      try {
        parsed = serviceAnnouncementSchema.safeParse(msg.json());
      } catch (jsonError) {
        options.onInvalid(jsonError);
        return;
      }
      if (!parsed.success) {
        options.onInvalid(parsed.error);
        return;
      }
      if (registry.announce(parsed.data)) options.onChange();
    },
  });
  const discover = () => {
    if (registry.expire()) options.onChange();
    if (!bus.nc.isClosed()) bus.nc.publish(DISCOVER_SUBJECT);
  };
  discover();
  const timer = setInterval(discover, options.interval);
  return {
    stop: async () => {
      clearInterval(timer);
      await sub.drain();
    },
  };
}
