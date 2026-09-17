# Gateway

The gateway is the only public entry point. Every browser, game and third-party request goes through it, and it's the only service that publishes a port. It decides which surface a request is for, finds the route in the tables services announce, resolves the caller's session, applies rate limits and the route's policy, and forwards the request with a short-lived internal identity token.

TLS isn't handled here. Terminate it in your own reverse proxy, or with the `edge` profile.

## Settings

```yaml
gateway:
  http: { port: 8000, max_body_size: 1048576, upstream_timeout: 30s }
  upstreams: {}
  discovery: { interval: 30s, expiry: 90s, startup_grace: 5s }
  session_cache: { ttl: 1m }
  identity_keys:
    encryption_key: '${env:KEY_ENCRYPTION_KEY}'
    rotate_after: 30d
    retain_after_rotation: 1h
  hsts: { max_age: 365d, include_subdomains: false, preload: false }

valkey:
  host: valkey
  port: 6379
  user: null
  password: '${env:VALKEY_PASSWORD}'
  database: 0
  tls: { enabled: false, ca_file: null }
  connect_timeout: 5s
  command_timeout: 1s

security:
  step_up_window: 10m
  encryption_key: '${env:APP_ENCRYPTION_KEY}'
  require_2fa_for_permissions: [users.*, safety.*, support.*]
```

- `http.port` is the public port for surfaces bound to hosts. Surfaces bound to `ports` listen on those ports as well. None of them may be `service.http.port`, which keeps `/metrics` and the other internal endpoints off the public listener.
- `http.max_body_size` is the largest request body accepted, in bytes. File uploads never pass through the gateway, so the default is enough for JSON.
- `upstreams` overrides where a service is reached. Services not listed are reached at `http://<service>:<service.http.port>`, which is what Compose gives you.
- `identity_keys.encryption_key` is required. It's a base64 32-byte key (`openssl rand -base64 32`). See [identity keys](#internal-identity-keys).
- `session_cache.ttl` is how long a resolved session is cached in Valkey. Revocations and account changes clear it sooner.
- `security.step_up_window` is how recently a session must have reached `aal2` for a route that needs step-up.
- `security.encryption_key` encrypts TOTP secrets in identity. See [identity.md](identity.md).
- `security.require_2fa_for_permissions` is which staff permissions need a passkey or TOTP before the rest of the product is available. Until then the session carries `two_factor_enrolment_required` and only enrolment routes are allowed.

The gateway also reads `geoip`, `session_security` and `features.session_security`, covered in [identity.md](identity.md#session-security).

Surfaces, cookies, CORS, trusted proxies and rate limits have their own sections, covered below.

## What happens to a request

1. **Surface.** The `Host` header and the port the request arrived on pick a surface. Where surfaces share a host, the longest matching `base_path` wins. A request that matches no surface gets `404`.
2. **Route.** The rest of the path is looked up in the route table. Unknown paths get `404 NOT_FOUND`, and known paths with the wrong method get `405 METHOD_NOT_ALLOWED` with an `Allow` header.
3. **Body.** Bodies over `http.max_body_size` get `413 PAYLOAD_TOO_LARGE`.
4. **Session.** The session cookie is resolved if present (see [sessions](#sessions)).
5. **Rate limits.** The route's policy and the `global` policy are applied (see [rate limiting](#rate-limiting)). Unknown paths and CORS preflights are counted against `global`.
6. **Origin.** A state-changing request (anything but `GET`, `HEAD` and `OPTIONS`) with an `Origin` that isn't allowed, or a session-cookie request without an `Origin`, gets `403 ORIGIN_NOT_ALLOWED`.
7. **Policy.** The route's declared policy is checked (see [route policy](#route-policy)).
8. **Forward.** The request goes to the service with a fresh identity token, and the response comes back with the gateway's headers added.

## Surfaces and route tables

Each service announces its routes on `qtiauth.sys.announce` when it starts and whenever asked. The gateway asks every `discovery.interval` and forgets an instance it hasn't heard from for `discovery.expiry`, so a stopped service's routes disappear on their own. Where replicas announce different manifests during an upgrade, the most recently started instance's manifest is used.

Routes are mounted per [SPEC §2.10](../SPEC.md#210-surfaces-hosts-and-sessions):

- `core` routes are mounted on every surface. Module routes are mounted only on surfaces that own the module (`surfaces.<name>.modules`).
- On the `account` and `support` surfaces, a route is mounted at `<base_path><path>`, so `/api/v1/me` is `/support/api/v1/me` on a support surface with base `/support`.
- On the `api` surface, the `/api` prefix of a route's path is replaced by the surface's base, so with base `/api` the same route is `/api/v1/me`, and with base `/` it's `/v1/me`. Other paths, such as `/oauth/token`, are mounted at the base as they are.

Two services declaring the same method and path on a surface is a conflict. Neither route is served, and both are reported at `/api/v1/meta/health`. A route naming a rate-limit policy that doesn't exist isn't served either, so no route can escape rate limiting.

### Origins

Each surface's `origins` are the addresses browsers use to reach it. They're added to the CORS allowlist, used for the `Origin` check and reported by `/api/v1/meta/features`. They default to `https://<host>` for each host. Set them explicitly when browsers use another scheme or port, and for surfaces bound only to ports:

```yaml
surfaces:
  account: { ports: [8080], base_path: /, origins: ['http://10.0.0.5:8080'] }
```

## Sessions

The session cookie is `__Host-<cookies.name>` (`__Host-qtiauth_session` by default), or `<cookies.name>` when `cookies.domain` is set. The cookie is resolved on every request so identity can restore an `aal0` session from `auth: none` sign-in routes. `sub` and permissions are only attached on `auth: session` routes; on other routes the caller is otherwise anonymous, with `sid` set when a session exists.

When a top-level navigation (`Sec-Fetch-Mode: navigate`, or `GET`/`HEAD` with `Accept: text/html`) needs a session on a host that does not share the account cookie, the gateway redirects to `/auth/bind` on the account surface and sets a one-minute `__Host-<cookies.name>_bound` cookie so a failed bind is not retried in a loop. `/auth/bind` itself, if the account host has no session, redirects to `/auth/login` with `return_to`. A top-level navigation whose session is at `aal0` is sent to `/auth/login`. API clients still get `401 AUTHENTICATION_REQUIRED`, or `403 REAUTHENTICATION_REQUIRED` when the session is at `aal0`.

The gateway hashes the cookie's token and looks the session up in Valkey. On a miss, when Valkey is down, or when `features.session_security.enabled` is on and the request's signals (IP, User-Agent, country, TLS fingerprint, timezone, screen, client fingerprint) differ from the cached snapshot, it asks identity over `qtiauth.rpc.identity.resolve_session` and caches the answer for `session_cache.ttl` or until the session expires. If identity can't be reached, the request gets `503 SERVICE_UNAVAILABLE`. A cookie that doesn't resolve to a session is cleared in the response.

Identity sets and clears the cookie when someone signs in or out, through headers on its responses (see [identity.md](identity.md#how-identity-sets-the-cookie)). The cookie lasts until the session's absolute expiry. When identity's response ends sessions, the gateway drops them from the cache before answering, so they stop working on the very next request from any replica.

Cached sessions are also dropped when identity publishes a session revocation or flag, a user update, ban, lock, restriction, deletion or age band change, a parental consent change, or a new legal document version. Replicas share one durable consumer, `gateway-session_cache`, for these events.

## Route policy

For `auth: session` routes, in order:

| Check                                                                       | Error                                                                                             |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| No session                                                                  | `401 AUTHENTICATION_REQUIRED`                                                                     |
| Account state not in `allow_account_states`                                 | `403 ACCOUNT_BANNED`, `ACCOUNT_LOCKED`, `PARENTAL_CONSENT_PENDING` or `ACCOUNT_STATE_NOT_ALLOWED` |
| Pending parental consent, without `allow_pending_parental_consent`          | `403 PARENTAL_CONSENT_PENDING`                                                                    |
| Updated legal documents not yet accepted, without `allow_pending_legal`     | `403 LEGAL_ACCEPTANCE_REQUIRED`                                                                   |
| Two-factor enrolment still required, without `allow_pending_2fa_enrolment`  | `403 TWO_FACTOR_ENROLMENT_REQUIRED`                                                               |
| Session at `aal0`, without `allow_aal0`                                     | `403 REAUTHENTICATION_REQUIRED`                                                                   |
| A required permission isn't granted                                         | `403 PERMISSION_DENIED`                                                                           |
| `step_up: true` and the session didn't reach `aal2` within `step_up_window` | `403 STEP_UP_REQUIRED`                                                                            |

`auth: none` routes skip these checks. Routes with `auth: oauth`, `service` or `game_authoritative` get `401 AUTHENTICATION_REQUIRED` until the OIDC provider is available.

## Internal identity keys

The gateway signs identity tokens with an Ed25519 key. The key set lives in the NATS key-value bucket `qtiauth_gateway`, so every replica uses the same keys and restarts keep them. Private keys are envelope-encrypted: each key is encrypted with its own random AES-256-GCM key, which is encrypted with `identity_keys.encryption_key`. The gateway refuses to start if it can't decrypt the current key, for example after the encryption key was changed.

The key is replaced once it's `rotate_after` old, checked at startup and on each `keys.rotate` cron tick. A replaced key stays in the published key set for `retain_after_rotation`, so tokens it signed can still be checked. Services fetch the key set over `qtiauth.rpc.gateway.identity_keys`, and fetch it again as soon as they see a token signed by a key they don't know, so a rotation takes effect straight away.

Losing the bucket isn't a problem: a new key is generated on the next start, and services pick it up the same way.

## Rate limiting

```yaml
rate_limits:
  global: { per: ip, limit: 300, window: 1m }
  auth_password: { per: [ip, account], limit: 10, window: 15m, on_store_failure: closed }
  magic_link_email: { per: email, limit: 3, window: 1h, on_store_failure: closed }
  magic_link_ip: { per: ip, limit: 10, window: 1h, on_store_failure: closed }
  magic_link_ip_day: { per: ip, limit: 20, window: 1d, on_store_failure: closed }
  magic_link: { policies: [magic_link_email, magic_link_ip, magic_link_ip_day] }
  auth_verify: { per: ip, limit: 30, window: 15m, on_store_failure: closed }
```

Routes name one policy in `rate_limit`. `global` applies to every request as well, so it must be a single policy.

- `per` is what's counted. `ip` is the client IP. `user` is the signed-in user, or the IP for anonymous callers. `client` is the OAuth client, or the IP. `email` is the `email` field of a JSON body, and `account` is its `identifier`, `email` or `username` field, trimmed and lowercased. A list counts each combination separately, so `[ip, account]` allows 10 attempts for each IP and account pair.
- A group (`policies: […]`) applies every listed policy, and the request is refused if any is exceeded.
- Windows slide: the count for the previous window is weighted by how much of it still overlaps, so there's no burst at a window boundary.
- `on_store_failure` decides what happens when Valkey can't be reached: `open` lets requests through, `closed` refuses them with `503 RATE_LIMIT_UNAVAILABLE`. The default is `open`. The built-in sign-in policies are `closed`.

Policies in your config replace built-in policies of the same name, and the rest of the built-in policies stay available.

Responses carry `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` and `RateLimit-Policy` for the policy closest to its limit. A refused request gets `429 RATE_LIMITED` with `Retry-After`. Counters are keyed by a hash of the counted values, so Valkey never holds IPs, emails or user IDs.

## Client IP

Without `network.trusted_proxies`, the client IP is the address that connected to the gateway. When that address is a trusted proxy, `X-Forwarded-For` is read from the right, skipping trusted proxies, and the first untrusted address is the client. List exactly the proxies in front of the gateway, since anything left of the first untrusted hop is whatever the client sent.

## CORS

Credentialed CORS is allowed for every surface origin and `cors.allowed_origins`. Preflights allow `GET`, `POST`, `PUT`, `PATCH` and `DELETE` with the `Content-Type`, `Authorization` and `X-Request-Id` headers, and are cached for 10 minutes. The `RateLimit-*`, `Retry-After` and `X-Request-Id` headers are exposed.

## What services receive

The gateway builds the forwarded request from scratch. Services get:

- The method, the route's path and the query string.
- `X-QTIAuth-Identity`, the identity token for that service.
- `X-Request-Id`, taken from the client when it's a short token, or new otherwise.
- `X-Forwarded-For` (the client IP), `X-Forwarded-Host` and `X-Forwarded-Proto` (from the surface's first origin).
- `Accept`, `Accept-Language`, `Content-Type`, `User-Agent`, `Origin`, `Idempotency-Key` and the conditional request headers, if the client sent them.
- `traceparent`, continuing the trace.

Cookies, `Authorization` and anything else the client sent are not forwarded. A service that doesn't respond within `http.upstream_timeout` gives `504 UPSTREAM_TIMEOUT`, and one that can't be reached gives `503 SERVICE_UNAVAILABLE`.

## Response headers

The session headers identity uses to set cookies are removed from every response, and ignored from any other service. Every response gets `Strict-Transport-Security` (from `hsts`), `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, a `Permissions-Policy` that turns off sensors, camera, microphone, geolocation, payment and USB, `X-Frame-Options: DENY` and `X-Request-Id`. Responses without a `Content-Security-Policy` get `default-src 'none'; frame-ancestors 'none'`. A service's own policy is kept, with `frame-ancestors 'none'` forced. `Server` and `X-Powered-By` are removed.

## Meta endpoints

These are served by the gateway on every surface, rate-limited by `global`:

| Endpoint                    | Answers                                                                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/meta/features` | Enabled modules and sub-features, auth methods and social providers, surfaces with their origins and modules, which surface pairs are same-site, and branding |
| `GET /api/v1/meta/health`   | `ok`, `starting` or `degraded`, the running services, any problems, and cross-site surface pairs                                                              |
| `GET /api/v1/meta/about`    | Product name and GeoIP attribution                                                                                                                            |
| `GET /about`                | The same attribution as HTML                                                                                                                                  |
| `GET /api/v1/openapi.json`  | OpenAPI 3.1 for every route on the surface it's requested from                                                                                                |

A module or sub-feature counts as enabled only when it's switched on in config and its service is running. Same-site means the same scheme and registrable domain (using the public suffix list). Browsers only send cookies on cross-surface `fetch` calls between same-site surfaces.

Health problems:

| Code                          | Meaning                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `SERVICE_NOT_RUNNING`         | A core service (`identity`, `notifier`, `scheduler`) isn't announcing itself                                       |
| `FEATURE_SERVICE_NOT_RUNNING` | A sub-feature is enabled but its service isn't running, e.g. `features.games.licensing.enabled` without `games`    |
| `ROUTE_CONFLICT`              | Two services declare the same route on a surface. Neither is served                                                |
| `UNKNOWN_RATE_LIMIT_POLICY`   | A route names a policy that isn't configured. The route isn't served                                               |
| `CROSS_SITE_SURFACES`         | Two surfaces are not same-site, so browsers will not send cookies on `fetch` between them. Does not degrade health |
| `GEOIP_UNAVAILABLE`           | The configured GeoIP source has no database (or is `none`). Country checks switch off. Does not degrade health     |

For `discovery.startup_grace` after the gateway starts, problems are reported with the status `starting` instead of `degraded`, while services are still announcing themselves.

The merged OpenAPI document lists, for every operation, the gateway's own error codes as well as the service's: `RATE_LIMITED` and the other codes above, depending on the route's policy.

## Errors

On top of the [codes every service can return](services.md#errors):

| Code                        | Status | When                                                              |
| --------------------------- | ------ | ----------------------------------------------------------------- |
| `AUTHENTICATION_REQUIRED`   | 401    | The route needs a signed-in caller                                |
| `ACCOUNT_BANNED`            | 403    | The account is banned and the route doesn't allow banned accounts |
| `ACCOUNT_LOCKED`            | 403    | The account is locked and the route doesn't allow locked accounts |
| `PARENTAL_CONSENT_PENDING`  | 403    | A guardian hasn't approved the account yet                        |
| `LEGAL_ACCEPTANCE_REQUIRED` | 403    | Updated legal documents must be accepted first                    |
| `REAUTHENTICATION_REQUIRED` | 403    | The session is at `aal0` and the route does not allow it          |
| `STEP_UP_REQUIRED`          | 403    | The route needs recent two-factor authentication                  |
| `ORIGIN_NOT_ALLOWED`        | 403    | A state-changing request came from an origin that isn't allowed   |
| `METHOD_NOT_ALLOWED`        | 405    | The path exists, but not for this method                          |
| `PAYLOAD_TOO_LARGE`         | 413    | The body is larger than `http.max_body_size`                      |
| `RATE_LIMITED`              | 429    | A rate-limit policy was exceeded                                  |
| `RATE_LIMIT_UNAVAILABLE`    | 503    | Valkey is unreachable and the policy fails closed                 |
| `UPSTREAM_TIMEOUT`          | 504    | The service didn't respond in time                                |

## Metrics

| Metric                                                   | Labels                                 |
| -------------------------------------------------------- | -------------------------------------- |
| `qtiauth_gateway_requests_total`                         | `surface`, `route`, `method`, `status` |
| `qtiauth_gateway_request_duration_seconds`               | `surface`, `route`, `method`           |
| `qtiauth_gateway_request_size_bytes`                     | `surface`, `route`                     |
| `qtiauth_gateway_response_size_bytes`                    | `surface`, `route`                     |
| `qtiauth_gateway_upstream_errors_total`                  | `upstream`, `reason`                   |
| `qtiauth_gateway_rate_limit_checks_total`                | `policy`, `outcome`                    |
| `qtiauth_gateway_session_lookups_total`                  | `outcome`                              |
| `qtiauth_gateway_identity_key_rotations_total`           |                                        |
| `qtiauth_gateway_identity_key_created_timestamp_seconds` |                                        |

`route` is the route template, or `unmatched`. Rate-limit outcomes are `allowed`, `limited`, `failed_open` and `failed_closed`. Watch `failed_open`: it means requests are getting through without being counted. `time() - qtiauth_gateway_identity_key_created_timestamp_seconds` is the signing key's age.

The gateway also writes one `info` log line per request with the surface, route template, method, status, duration and service. Paths, query strings, IPs and cookies are never logged.

---

## For developers

### Resolving sessions

Identity answers `qtiauth.rpc.identity.resolve_session`:

```json
{
  "binding_token_hash": "<base64url SHA-256 of the cookie token>",
  "cookie_scope": "me.example.com",
  "signals": {
    "ip": "203.0.113.10",
    "user_agent": "Mozilla/5.0 …",
    "country": "GB",
    "tls_fingerprint": null,
    "timezone": null,
    "screen": null,
    "client_fingerprint": null
  }
}
```

`cookie_scope` is `cookies.domain` if set, or the request's host. `signals` is sent when `features.session_security.enabled` is on. The answer is `{ "session": null }` or:

```json
{
  "session": {
    "session_id": "…",
    "user_id": "…",
    "account_state": "active",
    "permissions": [],
    "restrictions": [],
    "age_band": "adult",
    "parental_controls": null,
    "amr": ["email"],
    "acr": "aal1",
    "step_up_at": null,
    "legal_acceptance_required": false,
    "two_factor_enrolment_required": false,
    "expires_at": "2026-09-24T12:00:00Z"
  }
}
```

`resolvedSessionSchema` in `services/gateway/src/sessions.ts` is the exact shape. Cookie tokens must be 32 to 128 base64url characters, and anything else is treated as signed out without asking identity. Events that should clear cached sessions use a `user` or `session` subject, or carry `user_id` or `session_id` in their data.

### Tests

Unit tests build the request handler with in-memory stores: `memoryKeySetStore`, `memoryRateLimitStore` and `memorySessionCache`, and a `forward` function in place of real HTTP. `gatewayService({ hostPort: 0 })` starts the real thing on a random port for integration tests, and `gatewayService().gateway()` exposes its keyring, service registry, route table and Valkey client.
