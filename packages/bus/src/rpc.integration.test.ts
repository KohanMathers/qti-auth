import { sections } from '@qtiauth/config';
import { natsUrl, startNats } from '@qtiauth/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { type Bus, connectBus } from './connect.ts';
import { noopBusMetrics } from './metrics.ts';
import { type RpcContext, RpcError, rpcRequest, type RpcServer, serveRpc } from './rpc.ts';

let nats: Awaited<ReturnType<typeof startNats>>;
let identity: Bus;
let replica: Bus;
let gateway: Bus;
const servers: RpcServer[] = [];

interface Summary {
  user_id: string;
  served_by: string;
}

beforeAll(async () => {
  nats = await startNats();
  const config = sections.bus.parse({ servers: [natsUrl(nats)], request_timeout: '2s' });
  [identity, replica, gateway] = await Promise.all([
    connectBus(config, 'identity'),
    connectBus(config, 'identity'),
    connectBus(config, 'gateway'),
  ]);
  for (const [bus, name] of [
    [identity, 'first'],
    [replica, 'second'],
  ] as const) {
    servers.push(
      serveRpc<{ user_id: string }, Summary>(bus, {
        method: 'get_user_summary',
        handler: async ({ user_id }) => {
          await Promise.resolve();
          if (user_id === 'missing') throw new RpcError('not_found', 'No such user');
          if (user_id === 'broken') throw new Error('connection string with secrets');
          return { user_id, served_by: name };
        },
        onError: () => undefined,
      }),
    );
  }
  await Promise.all([identity.nc.flush(), replica.nc.flush()]);
});

afterAll(async () => {
  await Promise.all(servers.map((server) => server.stop()));
  await Promise.all([identity.close(), replica.close(), gateway.close()]);
  await nats.stop();
});

describe('request/reply', () => {
  it('returns the reply, load-balanced across replicas', async () => {
    const metrics = { ...noopBusMetrics, rpcRequest: vi.fn() };
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        rpcRequest<Summary>(
          gateway,
          'identity',
          'get_user_summary',
          { user_id: 'u1' },
          { metrics },
        ),
      ),
    );

    expect(results[0]).toMatchObject({ status: 'ok', data: { user_id: 'u1' } });
    const servedBy = new Set(results.map((r) => r.status === 'ok' && r.data.served_by));
    expect(servedBy).toEqual(new Set(['first', 'second']));
    expect(metrics.rpcRequest).toHaveBeenCalledWith(
      'qtiauth.rpc.identity.get_user_summary',
      'ok',
      expect.any(Number),
    );
  });

  it('passes on error codes but hides unexpected errors', async () => {
    const onError = vi.fn();
    const server = serveRpc(identity, {
      method: 'fail',
      handler: () => Promise.reject(new Error('connection string with secrets')),
      onError,
    });
    await identity.nc.flush();
    try {
      await expect(
        rpcRequest(gateway, 'identity', 'get_user_summary', { user_id: 'missing' }),
      ).resolves.toEqual({ status: 'error', code: 'not_found', message: 'No such user' });
      await expect(rpcRequest(gateway, 'identity', 'fail', {})).resolves.toEqual({
        status: 'error',
        code: 'internal',
        message: 'Internal error',
      });
      const [error, context] = onError.mock.calls[0] as [Error, RpcContext];
      expect(error.message).toBe('connection string with secrets');
      expect(context.subject).toBe('qtiauth.rpc.identity.fail');
      expect(context.deadline).toBeInstanceOf(Date);
    } finally {
      await server.stop();
    }
  });

  it('reports a service that is not running straight away, without waiting for the deadline', async () => {
    const metrics = { ...noopBusMetrics, rpcRequest: vi.fn() };
    const started = Date.now();
    await expect(
      rpcRequest(gateway, 'games', 'export_user', { user_id: 'u1' }, { timeout: 5_000, metrics }),
    ).resolves.toEqual({ status: 'no_responders' });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(metrics.rpcRequest).toHaveBeenCalledWith(
      'qtiauth.rpc.games.export_user',
      'no_responders',
      expect.any(Number),
    );
  });

  it('times out at the deadline and gives the handler that deadline', async () => {
    let context: RpcContext | undefined;
    const server = serveRpc(identity, {
      method: 'slow',
      handler: async (_request, ctx) => {
        context = ctx;
        await new Promise((resolve) => setTimeout(resolve, 500));
        return {};
      },
      onError: () => undefined,
    });
    await identity.nc.flush();
    try {
      const before = Date.now();
      await expect(rpcRequest(gateway, 'identity', 'slow', {}, { timeout: 100 })).resolves.toEqual({
        status: 'timeout',
      });
      expect(context?.deadline.getTime()).toBeGreaterThanOrEqual(before + 100);
      expect(context?.deadline.getTime()).toBeLessThanOrEqual(Date.now() + 100);
    } finally {
      await server.stop();
    }
  });

  it('finishes in-flight requests when a server stops', async () => {
    const server = serveRpc(identity, {
      method: 'drain',
      handler: async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return { done: true };
      },
      onError: () => undefined,
    });
    await identity.nc.flush();
    const reply = rpcRequest(gateway, 'identity', 'drain', {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    await server.stop();
    await expect(reply).resolves.toEqual({ status: 'ok', data: { done: true } });
  });
});
