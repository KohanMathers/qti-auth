import type { ServiceAnnouncement } from '@qtiauth/service-kit';
import { describe, expect, it } from 'vitest';

import { createServiceRegistry } from './discovery.ts';

function announcement(
  service: string,
  instance: string,
  overrides: Partial<ServiceAnnouncement> = {},
): ServiceAnnouncement {
  return {
    service,
    instance_id: instance,
    version: '1.0.0',
    started_at: '2026-09-17T12:00:00.000Z',
    manifest: { service, version: '1.0.0', routes: [], permissions: [] },
    ...overrides,
  };
}

describe('createServiceRegistry', () => {
  it('reports a change only when the running services change', () => {
    const registry = createServiceRegistry({ expiry: 90_000, now: () => 0 });
    expect(registry.announce(announcement('identity', 'a'))).toBe(true);
    expect(registry.announce(announcement('identity', 'a'))).toBe(false);
    expect(registry.announce(announcement('identity', 'b'))).toBe(true);
    expect(registry.services()).toMatchObject([{ name: 'identity', instances: 2 }]);
    expect(registry.isRunning('identity')).toBe(true);
    expect(registry.isRunning('games')).toBe(false);
  });

  it('uses the manifest of the most recently started instance', () => {
    const registry = createServiceRegistry({ expiry: 90_000, now: () => 0 });
    registry.announce(
      announcement('identity', 'new', {
        version: '1.1.0',
        started_at: '2026-09-17T13:00:00.000Z',
        manifest: { service: 'identity', version: '1.1.0', routes: [], permissions: [] },
      }),
    );
    registry.announce(announcement('identity', 'old'));
    expect(registry.services()).toMatchObject([
      { version: '1.1.0', manifest: { version: '1.1.0' } },
    ]);
  });

  it('forgets instances that stop announcing', () => {
    let at = 0;
    const registry = createServiceRegistry({ expiry: 90_000, now: () => at });
    registry.announce(announcement('identity', 'a'));
    at = 60_000;
    registry.announce(announcement('games', 'g'));
    at = 90_001;
    expect(registry.expire()).toBe(true);
    expect(registry.services().map((service) => service.name)).toEqual(['games']);
    expect(registry.expire()).toBe(false);
  });
});
