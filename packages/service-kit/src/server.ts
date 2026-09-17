import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    const done = () => {
      server.off('error', reject);
      resolve((server.address() as AddressInfo).port);
    };
    if (server.listening) {
      done();
      return;
    }
    server.once('error', reject);
    server.once('listening', done);
  });
}

export function closeServer(server: Server, timeout: number): Promise<void> {
  return new Promise((resolve) => {
    const force = setTimeout(() => {
      server.closeAllConnections();
    }, timeout);
    server.close(() => {
      clearTimeout(force);
      resolve();
    });
    server.closeIdleConnections();
  });
}

export async function unwind(stops: readonly (() => Promise<void>)[]): Promise<void> {
  const errors: unknown[] = [];
  for (const stop of [...stops].reverse()) {
    try {
      await stop();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, `unwind: ${String(errors.length)} shutdown step(s) failed`);
  }
}
