import { type ObjectStore, tryOpenObjectStore } from '@qtiauth/service-kit';

import type { Context } from './service.ts';

const attached = new WeakMap<Context, ObjectStore | null>();

export function attachObjectStore(ctx: Context, store: ObjectStore | null): void {
  attached.set(ctx, store);
}

export function objectStoreOf(ctx: Context): ObjectStore | null | undefined {
  return attached.get(ctx);
}

export function openObjectStore(ctx: Context, injected?: ObjectStore | null): ObjectStore | null {
  const existing = attached.get(ctx);
  if (existing !== undefined) return existing;
  const store = injected !== undefined ? injected : tryOpenObjectStore(ctx.config.storage);
  attached.set(ctx, store);
  return store;
}
