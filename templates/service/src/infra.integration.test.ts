import { type Infra, startInfra } from '@qtiauth/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('test infrastructure', () => {
  let infra: Infra;

  beforeAll(async () => {
    infra = await startInfra();
  });

  afterAll(async () => {
    await infra.stop();
  });

  it('starts Postgres', async () => {
    const result = await infra.postgres.exec(['pg_isready', '-U', infra.postgres.getUsername()]);
    expect(result.exitCode).toBe(0);
  });

  it('starts Valkey', async () => {
    const result = await infra.valkey.exec(['valkey-cli', 'ping']);
    expect(result.output.trim()).toBe('PONG');
  });

  it('starts NATS with JetStream', async () => {
    const url = `http://${infra.nats.getHost()}:${String(infra.nats.getMappedPort(8222))}/jsz`;
    const response = await fetch(url);
    expect(response.ok).toBe(true);
  });
});
