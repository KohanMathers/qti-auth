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

## Events

- `qtiauth.games.entitlement.granted.v1` — a user was granted a product. Subject is the entitlement.
- `qtiauth.games.entitlement.revoked.v1` — a product was revoked. Subject is the entitlement.

Both include `source`, `game_id`, `product_id` and `user_id`; the revoked event also carries a `reason` (`expired`, an admin-supplied reason, or `revoked` from the external API).
