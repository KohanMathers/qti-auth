import { NatsContainer, type StartedNatsContainer } from '@testcontainers/nats';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { type StartedValkeyContainer, ValkeyContainer } from '@testcontainers/valkey';

import { IMAGES } from './images.ts';

export { IMAGES } from './images.ts';

export function startPostgres(): Promise<StartedPostgreSqlContainer> {
  return new PostgreSqlContainer(IMAGES.postgres).start();
}

export function natsUrl(nats: StartedNatsContainer): string {
  return `nats://${nats.getHost()}:${String(nats.getMappedPort(4222))}`;
}

export function startValkey(): Promise<StartedValkeyContainer> {
  return new ValkeyContainer(IMAGES.valkey).start();
}

export function startNats(): Promise<StartedNatsContainer> {
  return new NatsContainer(IMAGES.nats).withJetStream().withArg('--http_port', '8222').start();
}

export interface Infra {
  postgres: StartedPostgreSqlContainer;
  valkey: StartedValkeyContainer;
  nats: StartedNatsContainer;
  stop: () => Promise<void>;
}

export async function startInfra(): Promise<Infra> {
  const [postgres, valkey, nats] = await Promise.all([startPostgres(), startValkey(), startNats()]);
  return {
    postgres,
    valkey,
    nats,
    stop: async () => {
      await Promise.all([postgres.stop(), valkey.stop(), nats.stop()]);
    },
  };
}
