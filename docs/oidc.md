# OIDC

OIDC is the OAuth 2.1 / OpenID Connect provider and developer portal. It runs with the `oidc` profile and uses the `oidc` schema. It issues authorization codes, JWT access tokens and ID tokens, stores consent, rotates refresh tokens and answers discovery, userinfo, revocation and introspection. It also issues `client_credentials` tokens, the device authorization grant (RFC 8628), pushed authorization requests (RFC 9126) and OpenID Connect back-channel logout. Users register their own clients in the developer portal; staff can verify or suspend them.

## Settings

```yaml
oidc:
  issuer: null
  resource: null
  signing:
    algorithm: ES256
    encryption_key: '${env:KEY_ENCRYPTION_KEY}'
    rotate_after: 90d
    retain_after_rotation: 1h
    refresh: 30s
  authorization_code_ttl: 1m
  access_ttl: 15m
  id_ttl: 15m
  refresh_ttl: 30d
  device_code_ttl: 15m
  device_interval: 5s
  pushed_authorization_ttl: 1m
  logout:
    timeout: 10s
    retry_window: 24h
    retry_delay: 1m
    max_retry_delay: 1h
    allow_private_targets: false
  developer_portal:
    max_clients_per_user: 10
  scopes: {}
  clients: {}

rate_limits:
  oauth_authorize: { per: ip, limit: 60, window: 1m }
  oauth_token: { per: ip, limit: 60, window: 1m, on_store_failure: closed }

retention:
  oauth: 30d
  delivery_logs: 30d
```

- `issuer` is advertised in discovery and used as JWT `iss`. `null` uses the api surface origin.
- `resource` is the access token audience (RFC 9068). `null` uses the issuer. Gateway `auth: oauth` and `auth: service` routes require this audience.
- `signing.algorithm` is `ES256` or `RS256`. ES256 signatures are IEEE P-1363.
- `signing.encryption_key` envelope-encrypts the signing keys at rest, the same way the gateway encrypts identity keys. OIDC refuses to start without it.
- `signing.retain_after_rotation` must be at least `access_ttl` and `id_ttl`, so a replaced key can still verify live tokens.
- `device_code_ttl` is how long a device-flow user can approve a code and the device can exchange it.
- `device_interval` is the minimum time between device-flow token polls. Faster polls get `slow_down` and the interval grows by 5 seconds.
- `pushed_authorization_ttl` is how long a PAR `request_uri` can be used at authorize.
- `logout.timeout` is how long a back-channel logout POST may take. Failed deliveries retry from `retry_delay`, doubling up to `max_retry_delay`, until `retry_window`. `oidc.logout.retry` ticks every minute, and oidc also polls due deliveries about once a second.
- `logout.allow_private_targets` allows URIs whose DNS resolves to private, loopback or link-local addresses. Loopback http URIs on `127.0.0.1` or `[::1]` are always allowed.
- `developer_portal.max_clients_per_user` (default 10) is how many OAuth clients a user may register.
- `scopes` adds or replaces scopes. Built-in scopes stay unless you replace them: `openid`, `profile`, `email`, `offline_access`, `age`, `parental_controls`, `restrictions`, `games`, `achievements` and `game_stats`.
- `clients` seeds clients on startup, keyed by `client_id`. Existing ids are left as they are; manage them in the developer portal after that. Confidential clients need a `secret`. `redirect_uris` may be empty for clients that only use the device flow or client credentials. `require_par: true` refuses authorize unless the request was pushed first. `backchannel_logout_uri` is an https URL, or http on `127.0.0.1` or `[::1]`. `backchannel_logout_session_required: true` requires `sid` in logout tokens.
- `retention.oauth` is how long used codes, expired requests and revoked tokens are kept before `retention.sweep` deletes them.
- `retention.delivery_logs` is how long back-channel logout delivery log rows are kept.

`features.oidc.backchannel_logout` (on by default) advertises back-channel logout in discovery and POSTs logout tokens. Token revocation on session end still runs when the feature is off. `features.oidc.developer_portal` (on by default) exposes the client registration API. Turning it off does not affect the protocol or staff verify/suspend.

## Endpoints

| Path                                                    | Auth    | Purpose                                                                          |
| ------------------------------------------------------- | ------- | -------------------------------------------------------------------------------- |
| `GET /.well-known/openid-configuration`                 | none    | Discovery                                                                        |
| `GET /.well-known/jwks.json`                            | none    | Public signing keys                                                              |
| `GET /oauth/authorize`                                  | session | Authorization code + PKCE S256, or a PAR `request_uri`                           |
| `GET`/`POST /oauth/consent`                             | session | Interim consent page                                                             |
| `POST /oauth/par`                                       | none    | Pushed Authorization Request (RFC 9126)                                          |
| `POST /oauth/device_authorization`                      | none    | Device Authorization Grant (RFC 8628)                                            |
| `GET`/`POST /oauth/device`                              | session | User code entry and confirmation page                                            |
| `POST /oauth/token`                                     | none    | `authorization_code`, `refresh_token`, `client_credentials` and the device grant |
| `GET /oauth/userinfo`                                   | oauth   | Claims the access token's scopes release                                         |
| `POST /oauth/revoke`                                    | none    | RFC 7009, always `200`                                                           |
| `POST /oauth/introspect`                                | none    | RFC 7662, confidential clients only                                              |
| `GET /api/v1/oauth/authorized`                          | session | Apps the signed-in user has authorized                                           |
| `DELETE /api/v1/oauth/authorized/:client_id`            | session | Revoke an app's tokens and stored consent                                        |
| `GET /api/v1/oauth/client`                              | service | The client authenticated by a client-credentials access token                    |
| `GET`/`POST /api/v1/oauth/clients`                      | session | List or register the signed-in user's OAuth clients                              |
| `GET`/`PATCH`/`DELETE /api/v1/oauth/clients/:client_id` | session | One owned client                                                                 |
| `POST /api/v1/oauth/clients/:client_id/secret`          | session | Replace a confidential client's secret. Needs step-up                            |
| `POST /api/v1/admin/oauth/clients/:client_id/verify`    | session | Mark a client verified (`oidc.clients.verify`)                                   |
| `POST /api/v1/admin/oauth/clients/:client_id/suspend`   | session | Suspend a client and revoke its tokens (`oidc.clients.suspend`)                  |
| `POST /api/v1/admin/oauth/clients/:client_id/unsuspend` | session | Lift a suspension (`oidc.clients.suspend`)                                       |

Token, revoke, introspect, PAR and device authorization take `application/x-www-form-urlencoded`. They answer OAuth JSON errors, not Problem Details. Authorize redirects with `error` when the `redirect_uri` is registered; otherwise it answers `invalid_request`.

PKCE `S256` is required for the authorization-code flow and PAR. Redirect URIs match exactly, including query. Native apps may register `http://127.0.0.1` or `http://[::1]`; any port is accepted at authorize time (RFC 8252).

First-party clients skip the consent screen. Stored consent skips it when the granted scopes already cover the request. Clients that are neither first-party nor admin-verified show an **Unverified app** notice. A child account (`age_band` other than `adult`) authorizing a non-first-party client is redirected with `access_denied` until guardian approval ships. The same rule applies when a child approves a device-flow request.

Refresh tokens rotate on every use. Presenting a rotated refresh token revokes the family and emits `qtiauth.oidc.refresh.reuse_detected.v1`. Reusing an authorization code revokes every token for that user and client.

Access tokens are RFC 9068 `at+jwt`. ID tokens are `JWT` with `at_hash`. Both are signed with the configured algorithm. `offline_access` is required for a refresh token.

`client_credentials` is confidential clients only. `openid` and `offline_access` are not allowed. The access token has no user: JWT `sub` is the `client_id`, and the gateway treats it as `auth: service`.

Device flow: the client posts to `/oauth/device_authorization` and polls `/oauth/token` with `grant_type=urn:ietf:params:oauth:grant-type:device_code`. The user opens `/oauth/device`, enters the code, and confirms with a POST so a scanner prefetch cannot consume it. Pending polls get `authorization_pending`; polling too fast gets `slow_down`.

PAR: the client posts the authorize parameters to `/oauth/par` and receives a one-time `request_uri`. Authorize then takes only `client_id` and `request_uri`. Clients with `require_par` cannot skip this.

## Developer portal

`POST /api/v1/oauth/clients` registers a public or confidential client. There is no approval gate: the client works at once. Confidential clients receive a secret once; regenerating it needs step-up. Names and descriptions go through the text filter (`qtiauth.rpc.identity.check_text`). Names containing `branding.product_name` are rejected unless the client is verified. Child accounts cannot register clients. `oidc.developer_portal.max_clients_per_user` caps how many a user may own.

Staff with `oidc.clients.verify` can mark a client verified, which is a badge on the consent screen, not a gate. Staff with `oidc.clients.suspend` can suspend a client, which revokes its access and refresh tokens and blocks new authorizations. Creating a client emits `qtiauth.oidc.client.created.v1`.

Portal errors: `DEVELOPER_PORTAL_DISABLED`, `CLIENT_CHILD_ACCOUNT`, `CLIENT_LIMIT_REACHED`, `CLIENT_NAME_REJECTED`, `CLIENT_DESCRIPTION_REJECTED`, `CLIENT_SECRET_NOT_APPLICABLE`, `CLIENT_NOT_FOUND`.

## Back-channel logout

When `features.oidc.backchannel_logout` is on, discovery includes `backchannel_logout_supported` and `backchannel_logout_session_supported`. Clients with a `backchannel_logout_uri` receive a POST (`application/x-www-form-urlencoded`, `logout_token`) when a session ends: logout on any surface, revocation, lock, ban or deletion.

The logout token is a `logout+jwt` signed with the same keys as ID tokens. Claims are `iss`, `aud` (the `client_id`), `sub`, `sid`, `iat`, `exp`, `jti` and `events` with `http://schemas.openid.net/event/backchannel-logout`. It never contains `nonce`. Results are stored in that client's delivery log.

Access tokens for the ended session are revoked. Refresh tokens for that session are revoked unless they include `offline_access`. Lock, ban and deletion revoke every refresh token for the user, including `offline_access`.

## Gateway

`auth: oauth` routes send `Authorization: Bearer` with a user access token. The gateway asks OIDC over `qtiauth.rpc.oidc.resolve_access_token`, checks the audience and the route's scopes, and forwards an identity token with `auth: oauth`. Session cookies are ignored on those routes.

`auth: service` routes take a `client_credentials` access token the same way, and forward `auth: service` with `client_id` and scopes and no user. A user access token is refused on service routes, and a service token is refused on oauth and session routes.

A browser navigation that needs a session and has none is redirected to `/auth/login?return_to=…` on the account surface. API callers get `401 AUTHENTICATION_REQUIRED`. Missing scopes are `403 INSUFFICIENT_SCOPE` with `missing_scopes`.

## Data rights

OIDC answers `qtiauth.rpc.oidc.export_user` with owned clients, consents, token metadata, device-flow authorizations and back-channel logout deliveries (hashes, secrets and logout tokens are not exported). `identity.user.deleted` deletes the user's owned clients, erases their authorization requests, codes, tokens, consents and device authorizations, and queues logout tokens for any remaining clients. Delivery log rows are kept until `retention.delivery_logs` so the POST can finish.

## Metrics

| Metric                                          | Labels                  |
| ----------------------------------------------- | ----------------------- |
| `qtiauth_oidc_authorizations_total`             | `client_type`, `result` |
| `qtiauth_oidc_token_grants_total`               | `grant_type`, `result`  |
| `qtiauth_oidc_device_approvals_total`           | `result`                |
| `qtiauth_oidc_refresh_reuse_total`              |                         |
| `qtiauth_oidc_introspections_total`             | `active`                |
| `qtiauth_oidc_logout_deliveries_total`          | `status`                |
| `qtiauth_oidc_logout_delivery_duration_seconds` | `outcome`               |
| `qtiauth_oidc_key_rotations_total`              |                         |
| `qtiauth_oidc_key_created_timestamp_seconds`    |                         |

Authorization `result` is `granted`, `denied` or `error`. Token `grant_type` is `authorization_code`, `refresh_token`, `client_credentials` or `device_code`, and `result` is `success` or `error`. Device approval `result` is `granted` or `denied`. `active` is `true` or `false`. Logout delivery `status` is `retrying`, `sent` or `failed`, and `outcome` is `ok` or `error`. `time() - qtiauth_oidc_key_created_timestamp_seconds` is the signing key's age.

Logs never contain tokens, codes, verifiers or client secrets. User IDs are hashed as usual.

---

## For developers

### Tests

Unit tests cover redirects, PKCE, JWT signing, scopes, claims, events, user codes, PAR parameter rules, logout token claims, developer-portal validation and the route manifest. `oidc.integration.test.ts` runs identity, OIDC and the gateway together: discovery, first-party skip, third-party consent, child `access_denied`, refresh reuse, revoke, introspect, an OAuth access token rejected on every `auth: session` route, a CLI-style device flow, client-credentials tokens refused on session and userinfo routes, PAR required per client, back-channel logout on sign-out and ban, and suspending a portal client so the next JWT check and introspection fail. `portal.integration.test.ts` covers client CRUD, the text filter, brand-name protection, the per-user limit, child accounts, verify, suspend and data export.
