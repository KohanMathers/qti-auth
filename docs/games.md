# Games

The games service holds the game and product catalog, tracks per-user entitlements and provisions the confidential server client each game uses to authenticate its back-end calls. It's part of the `games` compose profile and uses the `games` schema. Full spec: [SPEC.md §7](../SPEC.md).

Games have five statuses: `draft`, `hidden`, `early_access`, `released`, `archived`. Only `early_access` and `released` show on the public catalog; the others are staff-only. Every game has a base product created for it automatically, along with a confidential OAuth client (the "game server client") scoped to that one game. Products can be added, updated and removed except for the base, which stays with the game. Entitlements record which user owns which product, from which source (`admin_grant`, `key_redemption`, `steam`, `api`), and when they were granted, expire or were revoked.

## Settings

```yaml
games:
  default_lease_duration: 20d
  default_cloud_save_quota_bytes: 104857600
  server_client_name_suffix: server
  keys:
    charset: ABCDEFGHJKMNPQRSTUVWXYZ23456789
    group_length: 4
    groups: 4
    max_batch: 10000

features:
  games:
    licensing: { enabled: true }
    steam: { enabled: false }
    leaderboards: { enabled: true, require_game_authority: true }
    playtime: { enabled: true }
    cloud_saves: { enabled: false }
    keys: { enabled: true }
```

- `default_lease_duration` is used for offline licensing leases (P7.6) when a game doesn't set its own.
- `default_cloud_save_quota_bytes` is the fallback quota per user per game when cloud saves are enabled.
- `server_client_name_suffix` names the OAuth client created for a game's server. It is joined to the game's name with a space, then truncated at 80 characters so it fits `OIDC_CLIENT_NAME_MAX`.
- `keys.charset`, `keys.group_length` and `keys.groups` describe the format used for generated keys. The default is a Crockford-flavoured character set of 31 symbols with letters that look like digits removed, in four groups of four separated by hyphens (roughly 20 bits per group, 80 bits per key). Every code is stored hashed for lookup and separately sealed with the `security.encryption_key` so that the CSV export can return the plaintext.
- `keys.max_batch` caps how many keys can be generated in one call.

The catalog CRUD depends on the `games.catalog.manage` permission, the entitlement admin routes on `games.entitlements.manage`, and the key admin routes on `games.keys.manage`. The external grant API needs an OAuth access token or service token carrying the `games.entitlements.write` scope.

## Routes

Every path is mounted on the `account` surface unless noted.

| Route                                                                | Auth                                      |
| -------------------------------------------------------------------- | ----------------------------------------- |
| `GET /api/v1/games`                                                  | session                                   |
| `GET /api/v1/games/:slug`                                            | session                                   |
| `GET /api/v1/games/owned`                                            | session                                   |
| `GET /api/v1/games/:slug/owned`                                      | session                                   |
| `POST /api/v1/games/entitlements`                                    | service, scope `games.entitlements.write` |
| `POST /api/v1/games/entitlements/:entitlement_id/revoke`             | service, scope `games.entitlements.write` |
| `GET/POST /api/v1/admin/games`                                       | session, `games.catalog.manage`           |
| `GET/PATCH/DELETE /api/v1/admin/games/:slug`                         | session, `games.catalog.manage`           |
| `POST /api/v1/admin/games/:slug/server-client/rotate`                | session, `games.catalog.manage`, step up  |
| `GET/POST /api/v1/admin/games/:slug/products`                        | session, `games.catalog.manage`           |
| `PATCH/DELETE /api/v1/admin/games/:slug/products/:product_slug`      | session, `games.catalog.manage`           |
| `GET /api/v1/admin/entitlements`                                     | session, `games.entitlements.manage`      |
| `POST /api/v1/admin/games/:slug/products/:product_slug/entitlements` | session, `games.entitlements.manage`      |
| `POST /api/v1/admin/entitlements/:entitlement_id/revoke`             | session, `games.entitlements.manage`      |
| `GET /api/v1/games/keys/captcha`                                     | session                                   |
| `POST /api/v1/games/keys/redeem`                                     | session, `key_redeem` rate limit          |
| `GET /api/v1/admin/games/:slug/key-batches`                          | session, `games.keys.manage`              |
| `POST /api/v1/admin/games/:slug/products/:product_slug/key-batches`  | session, `games.keys.manage`              |
| `GET /api/v1/admin/key-batches/:batch_id`                            | session, `games.keys.manage`              |
| `GET /api/v1/admin/key-batches/:batch_id/keys.csv`                   | session, `games.keys.manage`, step up     |
| `POST /api/v1/admin/key-batches/:batch_id/revoke`                    | session, `games.keys.manage`              |

`POST /api/v1/admin/games` creates the game, the base product and the game server client in one call. The generated client secret is returned once in `server_client_secret`; the client id is stored on the game and shown on later requests but the secret is never returned again. Rotate it with `POST /api/v1/admin/games/:slug/server-client/rotate`, which requires step-up. Deleting a game retires the server client, then deletes the game row and cascades to its products and entitlements.

## Entitlement expiry

`grantEntitlement` refuses an `expires_at` in the past. When a timed grant is still active, the sweep job `games.expire_entitlements` (every 5 minutes by default) revokes it with reason `expired` and emits `qtiauth.games.entitlement.revoked.v1`. Revoked entitlements no longer count as owned and disappear from `owned` responses.

## Key redemption

Keys grant a product on redemption. Each batch belongs to one game and one product, carries a free-form `label` (for example `press` or `kickstarter`), an optional `expires_at`, and a `format` descriptor (`groups × group_length`). Every key stores a SHA-256 hash of its normalised code for lookup and a separately sealed copy of the plaintext so that the CSV export can be regenerated later.

On `POST /api/v1/admin/games/:slug/products/:product_slug/key-batches`, the response returns every plaintext code once. Later downloads use `GET /api/v1/admin/key-batches/:batch_id/keys.csv`, which needs step-up and returns four columns: `code`, `display`, `status` (`unused`, `redeemed`, `revoked`, `expired`) and `redeemed_at`.

`POST /api/v1/games/keys/redeem` normalises the submitted code (uppercase, hyphens and whitespace stripped), verifies the batch is neither revoked nor expired, and grants an entitlement with `source: key_redemption`. Rate limits come from the `key_redeem` policy (10 attempts per hour per IP and per user by default). Failed attempts (invalid, revoked or expired keys) count towards CAPTCHA. After `captcha.after` failures from an IP within `captcha.window`, the endpoint answers `GAMES_CAPTCHA_REQUIRED` with the widget details and needs a solved CAPTCHA on every retry until the counter clears. `GET /api/v1/games/keys/captcha` returns the current state so a UI can render the widget up front.

`POST /api/v1/admin/key-batches/:batch_id/revoke` revokes the batch and every unredeemed key in it. With `revoke_entitlements: true` it also revokes entitlements that were granted from this batch.

## Stats, leaderboards and playtime

Stat definitions per game carry a `key`, a `type` (`int`, `float`, `duration`), an `aggregation`
(`sum`, `max`, `min`, `latest`), an optional `max_delta_per_update` sanity bound and an `authority`.
Player-authority stats are written trust-based with the player's access token and the
`game_stats.write` scope. Game-authority stats are written only through `auth: game_authoritative`,
which needs the game server's `client_credentials` token in `Authorization: Bearer` and the player's
access token in `X-QTIAuth-Player-Token` — both issued to the same game.

Leaderboards are defined on a stat with a `sort` direction and a `reset_period` (`never`, `daily`,
`weekly`, `monthly` or `season:<slug>`). Periods roll over on the `leaderboards.reset_periodic` job.
With `features.games.leaderboards.require_game_authority: true` (the default), leaderboards may only
be created on stats with `authority: game`. Turn it off to allow trust-based leaderboards.

Accounts under 18 are hidden on leaderboards by default. Hidden entries still count in ranking but
appear as "Hidden player" to everyone except their owner. Players can flip their own visibility with
`POST /api/v1/games/:slug/leaderboards/:stat/:board/visibility`. Admins can remove a player's entry
(for example after a cheating investigation) with a reason, which is audited and emits
`qtiauth.games.leaderboard_entry.removed.v1`.

Playtime is trust-based: games start a session, heartbeat at least every 60 seconds and end it. The
service accrues per-day totals per game and feeds the guardian activity summary.
`GET /api/v1/games/:slug/playtime/remaining` returns the remaining daily allowance for accounts
with a `daily_playtime_minutes` parental control (or `null` when no limit applies). Sessions without
a recent heartbeat are closed automatically by the `leaderboards.reset_periodic` job.

Free-form per-user JSON is available at `GET/PUT /api/v1/games/:slug/custom-data`, capped at
32,768 bytes.

### What game authority does and doesn't protect against

The server credential proves a stat write came **through the game's server**. That stops anyone
scripting fake submissions straight at the API. It does **not** prove the score is legitimate: if
the game server just forwards whatever the client reports, memory editing and modified clients
still work. Leaderboards are only as trustworthy as the game server's own validation — server-side
simulation, replay checks, sanity bounds. `max_delta_per_update` on a stat helps catch impossible
single-write jumps, but the game is responsible for the rest. A game without its own server can't
write `authority: game` stats at all, because a server key shipped inside the client can be
extracted.

## Events

- `qtiauth.games.entitlement.granted.v1` — a user was granted a product. Subject is the entitlement.
- `qtiauth.games.entitlement.revoked.v1` — a product was revoked. Subject is the entitlement.
- `qtiauth.games.achievement.unlocked.v1` — a player unlocked an achievement. Subject is the unlock.
- `qtiauth.games.achievement.progressed.v1` — progress recorded without unlocking. Subject is the unlock.
- `qtiauth.games.achievement.revoked.v1` — an admin revoked an unlock. Subject is the unlock.
- `qtiauth.games.stat.updated.v1` — a player stat value changed. Subject is the stat definition.
- `qtiauth.games.leaderboard_entry.removed.v1` — an admin removed a leaderboard entry. Subject is the leaderboard.
- `qtiauth.games.playtime.ended.v1` — a playtime session finished. Subject is the session.

The entitlement events include `source`, `game_id`, `product_id` and `user_id`; the revoked variant also carries a `reason` (`expired`, an admin-supplied reason, or `revoked` from the external API).
