import type { HealthCheck } from '@qtiauth/observability';
import type { Valkey } from 'iovalkey';

export function valkeyHealthCheck(client: Valkey): HealthCheck {
  return async () => {
    await client.ping();
  };
}
