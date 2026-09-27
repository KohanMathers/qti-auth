import * as z from 'zod';

export const STEAM_IDENTITIES_SERVICE = 'identity';
export const STEAM_LOOKUP_METHOD = 'steam_lookup';
export const STEAM_IDENTITIES_PAGE_METHOD = 'steam_identities_page';

const steamIdPattern = /^\d{17}$/;

const steamId = z.string().regex(steamIdPattern, 'Must be a 17-digit SteamID64');

export const steamLookupRequestSchema = z.strictObject({
  steam_id: steamId,
});

export const steamLookupResponseSchema = z.strictObject({
  user_id: z.uuid().nullable(),
});

export const steamIdentitiesPageRequestSchema = z.strictObject({
  after: steamId.nullable().default(null),
  limit: z.int().min(1).max(500).default(100),
});

export const steamIdentityItemSchema = z.strictObject({
  steam_id: steamId,
  user_id: z.uuid(),
});

export const steamIdentitiesPageResponseSchema = z.strictObject({
  items: z.array(steamIdentityItemSchema),
  next: steamId.nullable(),
});

export type SteamLookupRequest = z.output<typeof steamLookupRequestSchema>;
export type SteamLookupResponse = z.output<typeof steamLookupResponseSchema>;
export type SteamIdentitiesPageRequest = z.output<typeof steamIdentitiesPageRequestSchema>;
export type SteamIdentityItem = z.output<typeof steamIdentityItemSchema>;
export type SteamIdentitiesPageResponse = z.output<typeof steamIdentitiesPageResponseSchema>;
