# Game integration

Developer guide for integrating a game with a QTIAuth deployment: signing the player in, checking entitlements, unlocking achievements, writing stats safely, verifying an offline licence, and linking a Steam account. It sits alongside [oidc.md](oidc.md) and [games.md](games.md), which have the full endpoint list and settings.

Nothing here needs a deployment-specific value in code. Everything is discoverable from the issuer's `/.well-known/openid-configuration` and the games API. Ship your game with the issuer URL and the game slug; nothing else.

## Tokens

A game deals with three kinds of token, and never mixes them:

- **Player access token.** Issued by the OIDC provider to the player, one per game (or per client) the player has authorized. Sent by the player from their device. Carries `sub` (the player's user id) and the scopes the player granted.
- **Game server token.** A `client_credentials` access token that authenticates the game's back-end server. Every game gets one confidential OAuth client automatically, with the `game_server` scope. It never leaves the server.
- **Offline licensing lease.** A signed JWT the player pulls once and keeps offline. Not sent to any QTIAuth endpoint until the player is back online.

The gateway keeps them strictly separate. A player token is refused on `auth: service` routes; a server token is refused on `auth: session` and `auth: oauth` player routes; a token from one game is refused on another game's game-authoritative route.

The internal identity token the gateway forwards to each service is a separate short-lived EdDSA token, not one of the above. Games never see it.

## Sign the player in

Two flows fit games. Pick the one that matches the device.

### Desktop and mobile with a browser: Authorization Code + PKCE

Use the standard OAuth 2.1 authorization code flow with PKCE `S256`. Register your client in the developer portal (a public client if you don't have a confidential secret; a confidential client for a game with its own back-end). Redirect URIs match exactly, including query. RFC 8252 native apps may register `http://127.0.0.1` and use any port at authorize time.

Scopes worth asking for:

- `openid profile` for `sub` and username.
- `age parental_controls restrictions` if the game needs to know what the account can do (see [child-safety defaults](#child-safety-defaults) below).
- `games` for owned products.
- `achievements game_stats` to unlock achievements and write player-authority stats.
- `offline_access` to get a refresh token. Refresh rotates on every use, so keep the newest one.

Endpoints are discovered from `/.well-known/openid-configuration` on the deployment's API surface.

### Consoles, TVs and CLI-style clients: Device Authorization Grant

For a device without a browser use RFC 8628. Post to `/oauth/device_authorization` with your `client_id` and `scope`; the response has `verification_uri`, `user_code`, `device_code` and `interval`. Show the user the URI and the code. Poll `/oauth/token` with `grant_type=urn:ietf:params:oauth:grant-type:device_code` and the device code, no faster than `interval` seconds. Pending polls answer `authorization_pending`; polling too fast answers `slow_down` and the interval grows by five seconds.

The user opens `/oauth/device` in a browser, types the code, confirms with a POST (a scanner prefetch cannot consume it), and your poll returns the tokens on the next tick.

### Steam-linked accounts

If the player's account is linked to Steam, your game can also authenticate them from a Steamworks session ticket without a browser or a device code. See [Steam](#steam) below.

## Owned products and entitlements

The player token with the `games` scope reads owned products:

```
GET /api/v1/games/owned                          # every game the player owns
GET /api/v1/games/<slug>/owned                   # products the player owns for this game
```

Products with `expires_at` in the past disappear when the entitlement sweep runs (`games.expire_entitlements`, every 5 minutes by default). Never cache expiry client-side beyond the token's own lifetime.

External grants (a payment processor, a bundle, a promo, an inventory API) go through the server token or an OAuth access token with `games.entitlements.write`:

```
POST /api/v1/games/entitlements
{ "user_id": "…", "game_slug": "…", "product_slug": "…",
  "source": "api", "expires_at": null }
```

`source` is one of `admin_grant`, `key_redemption`, `steam`, `api`. Products granted this way emit `qtiauth.games.entitlement.granted.v1`, so a webhook receiver can react (see [notifier.md](notifier.md)).

## Trust model

Every game event and webhook payload carries a `trust` field:

- `trust: game` — written through `auth: game_authoritative`, both tokens issued for the same game.
- `trust: player` — written with a player access token.

Anything a player token wrote is `trust: player`, whatever the game server did with it in between. QTIAuth's built-in automation never grants entitlements or keys from `trust: player` events. Your own webhook receivers should follow the same rule: don't act on player-trust events without game-server checks.

## Achievements

Achievements are defined per game with `key`, name, description, an optional `hidden` flag and, for progress achievements, a target value. Player-authority unlocks come from the player with the `achievements` scope:

```
POST /api/v1/games/<slug>/achievements/<key>/unlock
POST /api/v1/games/<slug>/achievements/<key>/progress   { "value": 42 }
```

Game-authority unlocks use `auth: game_authoritative` (below). A token issued for another game is refused: an achievement is scoped to its game.

Nightly, the games service computes rarity and writes it into the achievement definition, so game clients don't have to.

## Stats and leaderboards

Stat definitions carry `key`, `type` (`int`, `float`, `duration`), `aggregation` (`sum`, `max`, `min`, `latest`), an optional `max_delta_per_update` sanity bound and an `authority`:

- **Player-authority stats** are written with the player's access token and the `game_stats.write` scope. Convenient, but never trust them for anything that matters. A modified client can send whatever it wants.
- **Game-authority stats** are written only through `auth: game_authoritative`. The game server sends `Authorization: Bearer <server token>` and `X-QTIAuth-Player-Token: <player token>`; both must be issued for the same game and both must have `game_stats.write`. The service acts on the player token's `sub`.

Leaderboards live on a stat. With `features.games.leaderboards.require_game_authority: true` (the default), only game-authority stats can back a leaderboard. Turn it off if you need trust-based leaderboards. Under-18 accounts are hidden by default; players over that band can flip their own visibility with `POST /api/v1/games/<slug>/leaderboards/<stat>/<board>/visibility`.

### What game authority does and doesn't protect against

The server token proves a stat write went through the game's server. That stops anyone scripting fake submissions straight at the API. It does not prove the score is legitimate: if the game server just forwards whatever the client reports, memory editing and modified clients still work. Leaderboards are only as trustworthy as the server's own validation: server-side simulation, replay checks, sanity bounds, etc. `max_delta_per_update` on a stat helps catch impossible single-write jumps, but the game is responsible for the rest. A game without its own server can't write `authority: game` stats at all, because a server key shipped inside the client can be extracted.

## Offline leases

With `features.games.licensing.enabled: true`, the player can pull a signed lease that lists every product they own for a game:

```
POST /api/v1/games/<slug>/licensing/leases
```

The lease is a JWT typed `qtiauth-license+jwt`, signed with a dedicated key set separate from the OIDC keys. Publish the JWKS at `/.well-known/qtiauth-license-keys.json`.

Cache the JWKS in the game client, refresh it on lease renewal, and re-fetch when a lease's `kid` isn't known. Ship the sample verifiers from [games.md](games.md#sample-offline-verifier-typescript) as a starting point. Real integrations should also:

- Check `aud` matches the game slug they run for.
- Keep a revocation set from `GET /api/v1/games/licensing/revocations`, refreshed every `licensing.revocation_list_ttl` (5 min by default) while online.
- On a lease with device binding, hash the device id with SHA-256 and compare against the `device_hash` claim.

Leases expire at `exp`. Do not extend an expired lease client-side; ask for a new one.

## Child-safety defaults

The `age`, `parental_controls` and `restrictions` claims tell a game what the account can do. Games are responsible for enforcing them client-side and server-side; QTIAuth doesn't reach into the game world.

- `age_band` is one of the values from `age.bands` in config (`13_to_15`, `16_to_17`, `adult` by default).
- `parental_controls` is a map of controls the guardian set, such as `daily_playtime_minutes`.
- `restrictions` is a list of active moderation restrictions (see [safety.md](safety.md)), such as `chat` or `ugc`.

Read them once per session and re-read after any refresh. Playtime uses its own endpoint: `GET /api/v1/games/<slug>/playtime/remaining` returns remaining minutes for accounts with a `daily_playtime_minutes` control, or `null` when no limit applies. Start a session on entry, heartbeat at least every 60 seconds, and end it on exit. A session without a recent heartbeat is closed automatically.

## Steam

Steam linking is a config feature (`features.games.steam.enabled: true`). The operator provides a Steamworks partner key, and the games service does the rest.

- **Link.** From a signed-in session, `POST /api/v1/social/steam/link` starts an OpenID 2.0 flow to steamcommunity.com. On return the identity is linked to the account, with an unlink cooldown.
- **Ticket authentication.** From a game with a Steam player, POST `/api/v1/games/<slug>/steam/authenticate` with a Steamworks session ticket to get QTIAuth tokens for the linked account without a browser. Family-sharing policy and ban flags apply; an unlinked ticket returns a device-code response the game can show the player so they can link on their phone.
- **Ownership sync.** On link and nightly the games service reads the player's Steam ownership and grants matching entitlements with `source: steam`. It never revokes entitlements granted from other sources.

Tickets never appear in logs, traces or metric labels.

## When something goes wrong

- **`401 AUTHENTICATION_REQUIRED`** on a session route → the player token expired, or the session is at `aal0`. Refresh, or send the player to `/auth/login` on the account surface.
- **`403 INSUFFICIENT_SCOPE`** → your token doesn't have the scope. Discovery lists the scopes each endpoint needs; ask for them at authorize.
- **`403 STEP_UP_REQUIRED`** on an admin action → the session's step-up window has passed. Re-authenticate to `aal2` (passkey or TOTP) and try again.
- **`409` on a game-authoritative write** → the player token and server token weren't issued for the same game. Rotate the server client's secret only if it may have leaked; otherwise re-check the client_id you're using.
- **Signature errors on a lease** after a rotation → your client's cached JWKS is stale. Refetch `/.well-known/qtiauth-license-keys.json`.

For anything else, `/api/v1/meta/health` on the account surface reports which sub-features are enabled and which service is unavailable.
