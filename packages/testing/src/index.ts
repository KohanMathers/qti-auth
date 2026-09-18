import { NatsContainer, type StartedNatsContainer } from '@testcontainers/nats';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { type StartedValkeyContainer, ValkeyContainer } from '@testcontainers/valkey';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';

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

export interface StartedMinio {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
  stop: () => Promise<void>;
}

const MINIO_USER = 'qtiauth';
const MINIO_PASSWORD = 'qtiauth-minio';

export async function startMinio(): Promise<StartedMinio> {
  const container: StartedTestContainer = await new GenericContainer(IMAGES.minio)
    .withExposedPorts(9000)
    .withEnvironment({
      MINIO_ROOT_USER: MINIO_USER,
      MINIO_ROOT_PASSWORD: MINIO_PASSWORD,
    })
    .withCommand(['server', '/data', '--address', ':9000'])
    .withWaitStrategy(Wait.forHttp('/minio/health/live', 9000))
    .start();
  return {
    endpoint: `http://${container.getHost()}:${String(container.getMappedPort(9000))}`,
    accessKey: MINIO_USER,
    secretKey: MINIO_PASSWORD,
    bucket: 'qtiauth',
    stop: async () => {
      await container.stop();
    },
  };
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
