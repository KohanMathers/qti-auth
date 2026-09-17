import type { Valkey } from 'iovalkey';

export function valkeyHealthCheck(client: Valkey): () => Promise<void> {
  return async () => {
    await client.ping();
  };
}
