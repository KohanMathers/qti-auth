# OIDC

OIDC is the OAuth 2.1 / OpenID Connect provider. It runs with the `oidc` profile and uses the `oidc` schema. It issues authorization codes, JWT access tokens and ID tokens, stores consent, rotates refresh tokens and answers discovery, userinfo, revocation and introspection. It also issues `client_credentials` tokens, the device authorization grant (RFC 8628) and pushed authorization requests (RFC 9126).

It is not the developer portal or back-channel logout. Those come later.

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
  scopes: {}
  clients: {}

rate_limits:
  oauth_authorize: { per: ip, limit: 60, window: 1m }
  oauth_token: { per: ip, limit: 60, window: 1m, on_store_failure: closed }

retention:
  oauth: 30d
```

- `issuer` is advertised in discovery and used as JWT `iss`. `null` uses the api surface origin.
- `resource` is the access token audience (RFC 9068). `null` uses the issuer. Gateway `auth: oauth` and `auth: service` routes require this audience.
- `signing.algorithm` is `ES256` or `RS256`. ES256 signatures are IEEE P-1363.
- `signing.encryption_key` envelope-encrypts the signing keys at rest, the same way the gateway encrypts identity keys. OIDC refuses to start without it.
- `signing.retain_after_rotation` must be at least `access_ttl` and `id_ttl`, so a replaced key can still verify live tokens.
- `device_code_ttl` is how long a device-flow user can approve a code and the device can exchange it.
- `device_interval` is the minimum time between device-flow token polls. Faster polls get `slow_down` and the interval grows by 5 seconds.
- `pushed_authorization_ttl` is how long a PAR `request_uri` can be used at authorize.
- `scopes` adds or replaces scopes. Built-in scopes stay unless you replace them: `openid`, `profile`, `email`, `offline_access`, `age`, `parental_controls`, `restrictions`, `games`, `achievements` and `game_stats`.
- `clients` seeds clients on startup, keyed by `client_id`. Existing ids are left as they are; manage them in the developer portal after that. Confidential clients need a `secret`. `redirect_uris` may be empty for clients that only use the device flow or client credentials. `require_par: true` refuses authorize unless the request was pushed first.
- `retention.oauth` is how long used codes, expired requests and revoked tokens are kept before `retention.sweep` deletes them.

`features.oidc.developer_portal` and `features.oidc.backchannel_logout` are off until those features ship. They do not change the protocol here.

## Endpoints

| Path                                         | Auth    | Purpose                                                                          |
| -------------------------------------------- | ------- | -------------------------------------------------------------------------------- |
| `GET /.well-known/openid-configuration`      | none    | Discovery                                                                        |
| `GET /.well-known/jwks.json`                 | none    | Public signing keys                                                              |
| `GET /oauth/authorize`                       | session | Authorization code + PKCE S256, or a PAR `request_uri`                           |
| `GET`/`POST /oauth/consent`                  | session | Interim consent page                                                             |
| `POST /oauth/par`                            | none    | Pushed Authorization Request (RFC 9126)                                          |
| `POST /oauth/device_authorization`           | none    | Device Authorization Grant (RFC 8628)                                            |
| `GET`/`POST /oauth/device`                   | session | User code entry and confirmation page                                            |
| `POST /oauth/token`                          | none    | `authorization_code`, `refresh_token`, `client_credentials` and the device grant |
| `GET /oauth/userinfo`                        | oauth   | Claims the access token's scopes release                                         |
| `POST /oauth/revoke`                         | none    | RFC 7009, always `200`                                                           |
| `POST /oauth/introspect`                     | none    | RFC 7662, confidential clients only                                              |
| `GET /api/v1/oauth/authorized`               | session | Apps the signed-in user has authorized                                           |
| `DELETE /api/v1/oauth/authorized/:client_id` | session | Revoke an app's tokens and stored consent                                        |
| `GET /api/v1/oauth/client`                   | service | The client authenticated by a client-credentials access token                    |

Token, revoke, introspect, PAR and device authorization take `application/x-www-form-urlencoded`. They answer OAuth JSON errors, not Problem Details. Authorize redirects with `error` when the `redirect_uri` is registered; otherwise it answers `invalid_request`.

PKCE `S256` is required for the authorization-code flow and PAR. Redirect URIs match exactly, including query. Native apps may register `http://127.0.0.1` or `http://[::1]`; any port is accepted at authorize time (RFC 8252).

First-party clients skip the consent screen. Stored consent skips it when the granted scopes already cover the request. A child account (`age_band` other than `adult`) authorizing a non-first-party client is redirected with `access_denied` until guardian approval ships. The same rule applies when a child approves a device-flow request.

Refresh tokens rotate on every use. Presenting a rotated refresh token revokes the family and emits `qtiauth.oidc.refresh.reuse_detected.v1`. Reusing an authorization code revokes every token for that user and client.

Access tokens are RFC 9068 `at+jwt`. ID tokens are `JWT` with `at_hash`. Both are signed with the configured algorithm. `offline_access` is required for a refresh token.

`client_credentials` is confidential clients only. `openid` and `offline_access` are not allowed. The access token has no user: JWT `sub` is the `client_id`, and the gateway treats it as `auth: service`.

Device flow: the client posts to `/oauth/device_authorization` and polls `/oauth/token` with `grant_type=urn:ietf:params:oauth:grant-type:device_code`. The user opens `/oauth/device`, enters the code, and confirms with a POST so a scanner prefetch cannot consume it. Pending polls get `authorization_pending`; polling too fast gets `slow_down`.

PAR: the client posts the authorize parameters to `/oauth/par` and receives a one-time `request_uri`. Authorize then takes only `client_id` and `request_uri`. Clients with `require_par` cannot skip this.

## Gateway

`auth: oauth` routes send `Authorization: Bearer` with a user access token. The gateway asks OIDC over `qtiauth.rpc.oidc.resolve_access_token`, checks the audience and the route's scopes, and forwards an identity token with `auth: oauth`. Session cookies are ignored on those routes.

`auth: service` routes take a `client_credentials` access token the same way, and forward `auth: service` with `client_id` and scopes and no user. A user access token is refused on service routes, and a service token is refused on oauth and session routes.

A browser navigation that needs a session and has none is redirected to `/auth/login?return_to=…` on the account surface. API callers get `401 AUTHENTICATION_REQUIRED`. Missing scopes are `403 INSUFFICIENT_SCOPE` with `missing_scopes`.

## Data rights

OIDC answers `qtiauth.rpc.oidc.export_user` with consents, token metadata and device-flow authorizations (hashes are not exported). `identity.user.deleted` erases the user's authorization requests, codes, tokens, consents and device authorizations.

## Metrics

| Metric                                       | Labels                  |
| -------------------------------------------- | ----------------------- |
| `qtiauth_oidc_authorizations_total`          | `client_type`, `result` |
| `qtiauth_oidc_token_grants_total`            | `grant_type`, `result`  |
| `qtiauth_oidc_device_approvals_total`        | `result`                |
| `qtiauth_oidc_refresh_reuse_total`           |                         |
| `qtiauth_oidc_introspections_total`          | `active`                |
| `qtiauth_oidc_key_rotations_total`           |                         |
| `qtiauth_oidc_key_created_timestamp_seconds` |                         |

Authorization `result` is `granted`, `denied` or `error`. Token `grant_type` is `authorization_code`, `refresh_token`, `client_credentials` or `device_code`, and `result` is `success` or `error`. Device approval `result` is `granted` or `denied`. `active` is `true` or `false`. `time() - qtiauth_oidc_key_created_timestamp_seconds` is the signing key's age.

Logs never contain tokens, codes, verifiers or client secrets. User IDs are hashed as usual.

---

## For developers

### Tests

Unit tests cover redirects, PKCE, JWT signing, scopes, claims, events, user codes, PAR parameter rules and the route manifest. `oidc.integration.test.ts` runs identity, OIDC and the gateway together: discovery, first-party skip, third-party consent, child `access_denied`, refresh reuse, revoke, introspect, an OAuth access token rejected on every `auth: session` route, a CLI-style device flow, client-credentials tokens refused on session and userinfo routes, and PAR required per client.
