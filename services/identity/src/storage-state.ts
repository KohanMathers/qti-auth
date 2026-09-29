import { type ObjectStore, tryOpenObjectStore } from '@qtiauth/service-kit';

import { contextAttachment } from './attachments.ts';
import type { Context } from './service.ts';

const attachment = contextAttachment<ObjectStore | null>();
export const attachObjectStore = attachment.attach;

export function objectStoreOf(ctx: Context): ObjectStore | null {
  return attachment.of(ctx) ?? null;
}

export function sharedObjectStore(ctx: Context): ObjectStore | null {
  const attached = attachment.of(ctx);
  if (attached !== undefined) return attached;
  const store = tryOpenObjectStore(ctx.config.storage);
  attachment.attach(ctx, store);
  return store;
}
