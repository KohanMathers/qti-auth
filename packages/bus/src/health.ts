import type { HealthCheck } from '@qtiauth/observability';

import type { Bus } from './connect.ts';

export function busHealthCheck(bus: Bus): HealthCheck {
  return async () => {
    if (bus.nc.isClosed()) throw new Error('NATS connection is closed');
    await bus.nc.flush();
  };
}
