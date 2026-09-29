import type { Asset, AssetSet } from './assets.ts';
import type { LocaleSet } from './locale.ts';
import { contextAttachment } from './state.ts';

export interface WebState {
  assets: AssetSet;
  templates: Asset;
  locales: LocaleSet;
  basePath: string;
  metaOrigin: string | undefined;
}

const attachment = contextAttachment<WebState>();

export const attachWebState = attachment.attach;
export const webStateOf = attachment.of;

export class WebStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebStateError';
  }
}

export function requireWebState(ctx: Parameters<typeof attachment.of>[0]): WebState {
  const state = webStateOf(ctx);
  if (state === undefined) throw new WebStateError('Web state has not been attached');
  return state;
}
