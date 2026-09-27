import type { Context } from './service.ts';
import { createSteamWebClient, type SteamWebClient } from './steam.ts';

const attached = new WeakMap<Context, SteamWebClient>();

export function attachSteamClient(ctx: Context, client: SteamWebClient): void {
  attached.set(ctx, client);
}

export function steamClientOf(ctx: Context): SteamWebClient {
  const existing = attached.get(ctx);
  if (existing) return existing;
  const client = createSteamWebClient({
    host: ctx.config.games.steam.web_api_host,
    publisherKey: ctx.config.games.steam.publisher_key,
    timeoutMs: ctx.config.games.steam.request_timeout,
  });
  attached.set(ctx, client);
  return client;
}
