import type { Context } from './service.ts';

export interface Attachment<T> {
  attach: (ctx: Context, value: T) => void;
  of: (ctx: Context) => T | undefined;
}

export function contextAttachment<T>(): Attachment<T> {
  const attached = new WeakMap<Context, T>();
  return {
    attach: (ctx, value) => {
      attached.set(ctx, value);
    },
    of: (ctx) => attached.get(ctx),
  };
}
