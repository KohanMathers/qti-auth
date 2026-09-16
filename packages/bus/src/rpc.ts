import { errors, headers, type Msg } from '@nats-io/transport-node';

import type { Bus } from './connect.ts';
import { type BusMetrics, noopBusMetrics } from './metrics.ts';
import { rpcQueueGroup, rpcSubject } from './subjects.ts';

export const DEADLINE_HEADER = 'QTIAuth-Deadline';

export type RpcResult<T> =
  | { status: 'ok'; data: T }
  | { status: 'error'; code: string; message: string }
  | { status: 'timeout' }
  | { status: 'no_responders' };

type RpcResponse<T> =
  { ok: true; data: T } | { ok: false; error: { code: string; message: string } };

export interface RpcRequestOptions {
  timeout?: number;
  metrics?: BusMetrics;
}

export interface RpcContext {
  deadline: Date;
  subject: string;
}

export interface RpcServerOptions<Req, Res> {
  method: string;
  handler: (request: Req, context: RpcContext) => Promise<Res>;
  onError: (error: unknown, context: RpcContext) => void;
}

export interface RpcServer {
  subject: string;
  stop: () => Promise<void>;
}

export class RpcError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
  }
}

function isTimeout(error: unknown): boolean {
  return (
    error instanceof errors.TimeoutError ||
    (error instanceof errors.RequestError && error.cause instanceof errors.TimeoutError)
  );
}

function isNoResponders(error: unknown): boolean {
  return (
    error instanceof errors.NoRespondersError ||
    (error instanceof errors.RequestError && error.isNoResponders())
  );
}

export async function rpcRequest<T>(
  bus: Bus,
  service: string,
  method: string,
  request: unknown,
  options: RpcRequestOptions = {},
): Promise<RpcResult<T>> {
  const subject = rpcSubject(service, method);
  const metrics = options.metrics ?? noopBusMetrics;
  const timeout = options.timeout ?? bus.config.request_timeout;
  const hdrs = headers();
  hdrs.set(DEADLINE_HEADER, String(Date.now() + timeout));

  const started = performance.now();
  const elapsed = () => (performance.now() - started) / 1000;
  let reply: Msg;
  try {
    reply = await bus.nc.request(subject, JSON.stringify(request), { timeout, headers: hdrs });
  } catch (error) {
    if (isNoResponders(error)) {
      metrics.rpcRequest(subject, 'no_responders', elapsed());
      return { status: 'no_responders' };
    }
    if (isTimeout(error)) {
      metrics.rpcRequest(subject, 'timeout', elapsed());
      return { status: 'timeout' };
    }
    throw error;
  }

  const response = reply.json<RpcResponse<T>>();
  metrics.rpcRequest(subject, response.ok ? 'ok' : 'error', elapsed());
  return response.ok
    ? { status: 'ok', data: response.data }
    : { status: 'error', ...response.error };
}

export function serveRpc<Req, Res>(bus: Bus, options: RpcServerOptions<Req, Res>): RpcServer {
  const subject = rpcSubject(bus.service, options.method);
  const inFlight = new Set<Promise<void>>();

  const handle = async (msg: Msg): Promise<void> => {
    const deadline = new Date(
      msg.headers?.has(DEADLINE_HEADER) ? Number(msg.headers.get(DEADLINE_HEADER)) : Number.NaN,
    );
    const context = { deadline, subject };
    if (Number.isNaN(deadline.getTime())) {
      msg.respond(
        JSON.stringify({
          ok: false,
          error: { code: 'bad_request', message: `Missing ${DEADLINE_HEADER} header` },
        }),
      );
      return;
    }
    if (deadline.getTime() <= Date.now()) return;

    let response: RpcResponse<Res>;
    try {
      let request: Req;
      try {
        request = msg.json<Req>();
      } catch {
        throw new RpcError('bad_request', 'Request body must be JSON');
      }
      response = { ok: true, data: await options.handler(request, context) };
    } catch (error) {
      if (error instanceof RpcError) {
        response = { ok: false, error: { code: error.code, message: error.message } };
      } else {
        options.onError(error, context);
        response = { ok: false, error: { code: 'internal', message: 'Internal error' } };
      }
    }
    if (deadline.getTime() > Date.now()) msg.respond(JSON.stringify(response));
  };

  const sub = bus.nc.subscribe(subject, {
    queue: rpcQueueGroup(bus.service),
    callback: (error, msg) => {
      if (error) return;
      const task = handle(msg).finally(() => inFlight.delete(task));
      inFlight.add(task);
    },
  });

  return {
    subject,
    stop: async () => {
      await sub.drain();
      await Promise.all(inFlight);
    },
  };
}
