import type { HealthCheck } from '@qtiauth/observability';

import type { ObjectStore } from './store.ts';

export function storageHealthCheck(store: ObjectStore): HealthCheck {
  return () => store.checkBucket();
}
