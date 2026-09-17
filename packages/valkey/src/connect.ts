import { readFileSync } from 'node:fs';

import type { QtiauthConfig } from '@qtiauth/config';
import { type RedisOptions, Valkey } from 'iovalkey';

export type ValkeyConfig = QtiauthConfig['valkey'];
export type { Valkey };

export const KEY_PREFIX = 'qtiauth:';

const MAX_RECONNECT_DELAY = 5_000;

export function valkeyOptions(config: ValkeyConfig, service: string): RedisOptions {
  const { tls } = config;
  return {
    host: config.host,
    port: config.port,
    db: config.database,
    connectionName: `qtiauth-${service}`,
    connectTimeout: config.connect_timeout,
    commandTimeout: config.command_timeout,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    retryStrategy: (attempt) => Math.min(attempt * 100, MAX_RECONNECT_DELAY),
    ...(config.user === null ? {} : { username: config.user }),
    ...(config.password === '' ? {} : { password: config.password }),
    ...(tls.enabled ? { tls: tls.ca_file === null ? {} : { ca: readFileSync(tls.ca_file) } } : {}),
  };
}

export function connectValkey(config: ValkeyConfig, service: string): Valkey {
  const client = new Valkey(valkeyOptions(config, service));
  client.on('error', () => undefined);
  return client;
}

export async function closeValkey(client: Valkey): Promise<void> {
  if (client.status === 'end') return;
  try {
    await client.quit();
  } catch {
    client.disconnect();
  }
}
