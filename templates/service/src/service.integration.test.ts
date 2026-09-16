import { type Bus, connectBus, rpcRequest } from '@qtiauth/bus';
import { sections } from '@qtiauth/config';
import { captureLogs } from '@qtiauth/observability/testing';
import {
  ANNOUNCE_SUBJECT,
  DISCOVER_SUBJECT,
  OPENAPI_METHOD,
  type RunningService,
  startService,
} from '@qtiauth/service-kit';
import {
  generateIdentityKey,
  identityHeaders,
  serveTestIdentityKeys,
} from '@qtiauth/service-kit/testing';
import { natsUrl, startNats } from '@qtiauth/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { definition, router } from './service.ts';

const key = generateIdentityKey();

let nats: Awaited<ReturnType<typeof startNats>>;
let gateway: Bus;
let service: RunningService<typeof definition>;

beforeAll(async () => {
  nats = await startNats();
  const bus = sections.bus.parse({ servers: [natsUrl(nats)] });
  gateway = await connectBus(bus, 'gateway');
  serveTestIdentityKeys(gateway, key);
  service = await startService(definition, {
    router,
    port: 0,
    tracing: false,
    logDestination: captureLogs().destination,
    config: {
      service: sections.service.parse({}),
      observability: sections.observability.parse({}),
      bus,
      database: sections.database.parse({}),
      migrations: sections.migrations.parse({}),
    },
  });
});

afterAll(async () => {
  await service.stop();
  await gateway.close();
  await nats.stop();
});

describe('template service with the service kit', () => {
  it('has health endpoints', async () => {
    expect((await fetch(`${service.url}/healthz`)).status).toBe(200);
    expect(await (await fetch(`${service.url}/readyz`)).json()).toMatchObject({
      status: 'ok',
      service: 'template',
      checks: { nats: { status: 'ok' } },
    });
  });

  it('has metrics', async () => {
    await fetch(`${service.url}/api/v1/template/hello`, {
      headers: identityHeaders(key, 'template'),
    });
    const metrics = await (await fetch(`${service.url}/metrics`)).text();
    expect(metrics).toContain(
      'qtiauth_http_requests_total{method="GET",route="/api/v1/template/hello",status="200",service="template"} 1',
    );
  });

  it('announces a manifest', async () => {
    const announcement = new Promise((resolve) => {
      gateway.nc.subscribe(ANNOUNCE_SUBJECT, {
        max: 1,
        callback: (_error, msg) => {
          resolve(msg.json());
        },
      });
      gateway.nc.publish(DISCOVER_SUBJECT);
    });
    expect(await announcement).toMatchObject({
      service: 'template',
      manifest: { routes: [{ path: '/api/v1/template/hello' }] },
    });
  });

  it('has OpenAPI', async () => {
    expect(await (await fetch(`${service.url}/openapi.json`)).json()).toMatchObject({
      paths: { '/api/v1/template/hello': { get: { operationId: 'hello' } } },
    });
    expect(await rpcRequest(gateway, 'template', OPENAPI_METHOD, {})).toMatchObject({
      status: 'ok',
    });
  });
});
