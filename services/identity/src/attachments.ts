import type { Context } from './service.ts';

export interface Attachment<T> {
  attach: (ctx: Context, value: T) => void;
  of: (ctx: Context) => T | undefined;
}

/**
 * A per-service value that routes read but the service definition does not
 * carry, such as a Valkey-backed store opened at startup. Keyed on the service
 * context so tests can attach their own without touching module state.
 */
export function contextAttachment<T>(): Attachment<T> {
  const attached = new WeakMap<Context, T>();
  return {
    attach: (ctx, value) => {
      attached.set(ctx, value);
    },
    of: (ctx) => attached.get(ctx),
  };
}
