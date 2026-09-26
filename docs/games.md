# Games

The games service holds the game and product catalog, tracks per-user entitlements and provisions the confidential server client each game uses to authenticate its back-end calls. It's part of the `games` compose profile and uses the `games` schema. Full spec: [SPEC.md §7](../SPEC.md).

Games have five statuses: `draft`, `hidden`, `early_access`, `released`, `archived`. Only `early_access` and `released` show on the public catalog; the others are staff-only. Every game has a base product created for it automatically, along with a confidential OAuth client (the "game server client") scoped to that one game. Products can be added, updated and removed except for the base, which stays with the game. Entitlements record which user owns which product, from which source (`admin_grant`, `key_redemption`, `steam`, `api`), and when they were granted, expire or were revoked.

## Settings

```yaml
games:
  default_lease_duration: 20d
  default_cloud_save_quota_bytes: 104857600
  server_client_name_suffix: server

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

The catalog CRUD depends on the `games.catalog.manage` permission and the entitlement admin routes on `games.entitlements.manage`. The external grant API needs an OAuth access token or service token carrying the `games.entitlements.write` scope.

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

`POST /api/v1/admin/games` creates the game, the base product and the game server client in one call. The generated client secret is returned once in `server_client_secret`; the client id is stored on the game and shown on later requests but the secret is never returned again. Rotate it with `POST /api/v1/admin/games/:slug/server-client/rotate`, which requires step-up. Deleting a game retires the server client, then deletes the game row and cascades to its products and entitlements.

## Entitlement expiry

`grantEntitlement` refuses an `expires_at` in the past. When a timed grant is still active, the sweep job `games.expire_entitlements` (every 5 minutes by default) revokes it with reason `expired` and emits `qtiauth.games.entitlement.revoked.v1`. Revoked entitlements no longer count as owned and disappear from `owned` responses.

## Events

- `qtiauth.games.entitlement.granted.v1` — a user was granted a product. Subject is the entitlement.
- `qtiauth.games.entitlement.revoked.v1` — a product was revoked. Subject is the entitlement.

Both include `source`, `game_id`, `product_id` and `user_id`; the revoked event also carries a `reason` (`expired`, an admin-supplied reason, or `revoked` from the external API).
