import type { Bus } from '@qtiauth/bus';

import {
  ANNOUNCE_SUBJECT,
  DISCOVER_SUBJECT,
  type ServiceAnnouncement,
  serviceAnnouncementSchema,
} from './announce.ts';
import type { RouteManifest } from './routes.ts';

export interface DiscoveredService {
  name: string;
  version: string;
  instances: number;
  manifest: RouteManifest;
}

export interface ServiceRegistry {
  announce: (announcement: ServiceAnnouncement) => boolean;
  expire: () => boolean;
  services: () => DiscoveredService[];
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

  const summarize = (
    name: string,
    announcements: readonly ServiceAnnouncement[],
  ): DiscoveredService | undefined => {
    const latest = announcements.reduce<ServiceAnnouncement | undefined>(
      (a, b) => (a === undefined || Date.parse(b.started_at) > Date.parse(a.started_at) ? b : a),
      undefined,
    );
    if (latest === undefined) return undefined;
    return {
      name,
      version: latest.version,
      instances: announcements.length,
      manifest: latest.manifest,
    };
  };

  const announcementsOf = (name: string): ServiceAnnouncement[] =>
    [...instances.values()]
      .map(({ announcement }) => announcement)
      .filter((announcement) => announcement.service === name);

  const services = (): DiscoveredService[] => {
    const names = new Set([...instances.values()].map(({ announcement }) => announcement.service));
    return [...names]
      .flatMap((name) => summarize(name, announcementsOf(name)) ?? [])
      .sort((a, b) => a.name.localeCompare(b.name));
  };

  const fingerprint = (names: readonly string[]): string =>
    JSON.stringify(names.map((name) => summarize(name, announcementsOf(name)) ?? null));

  return {
    announce: (announcement) => {
      const previous = instances.get(announcement.instance_id)?.announcement.service;
      const names = [announcement.service, ...(previous === undefined ? [] : [previous])];
      const before = fingerprint(names);
      instances.set(announcement.instance_id, { announcement, seenAt: now() });
      return fingerprint(names) !== before;
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
