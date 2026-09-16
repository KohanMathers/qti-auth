import { type Bus, SUBJECT_PREFIX } from '@qtiauth/bus';
import * as z from 'zod';

import { routeManifestSchema } from './routes.ts';

export const ANNOUNCE_SUBJECT = `${SUBJECT_PREFIX}.sys.announce`;
export const DISCOVER_SUBJECT = `${SUBJECT_PREFIX}.sys.discover`;

export const serviceAnnouncementSchema = z.strictObject({
  service: z.string().min(1),
  instance_id: z.string().min(1),
  version: z.string().min(1),
  started_at: z.iso.datetime(),
  manifest: routeManifestSchema,
});

export type ServiceAnnouncement = z.output<typeof serviceAnnouncementSchema>;

export interface Announcer {
  announce: () => void;
  stop: () => Promise<void>;
}

export function startAnnouncer(bus: Bus, announcement: ServiceAnnouncement): Announcer {
  const payload = JSON.stringify(serviceAnnouncementSchema.parse(announcement));
  const announce = () => {
    if (!bus.nc.isClosed()) bus.nc.publish(ANNOUNCE_SUBJECT, payload);
  };
  const sub = bus.nc.subscribe(DISCOVER_SUBJECT, {
    callback: (error) => {
      if (!error) announce();
    },
  });
  announce();
  return {
    announce,
    stop: () => sub.drain(),
  };
}
