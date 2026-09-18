# QTIAuth — Specification

**Status:** Final. Approved 2026-09-16
**Replaces:** the Cloudflare Workers + D1 implementation in this repo
**Next step:** development roadmap

---

## 0. Conventions

- Everything in this document is **in scope for v1** unless marked `LATER`.
- **QTIAuth** is the project name. Deployments are brand-neutral: product name, company, domains
  and every other deployment-specific value come from config (§3).
- "Must", "never" and "always" are requirements. Examples and defaults can be changed in config
  unless stated otherwise.

### Revision notes (annotated draft → final)

- **Migrations** now run per service at that service's startup, so upgrading one service's image
  migrates only its schema. Replaces the one-shot `migrate` container. (§2.3)
- **Surfaces:** the core API is mounted on every surface, and module APIs only on the surface that
  owns them. Cross-surface calls go through the owning surface's host/base path. (§2.10)
- **One session across every surface**, including surfaces on different registrable domains, via
  per-host session bindings. Replaces the "child session" handoff. (§2.10)
- **Back-channel logout** moved from later into v1. (§6.1)
- **Game-authoritative leaderboards:** scores feeding a leaderboard need both the game's server
  credential and the player's token. This is toggleable in config. Achievements, other stats and
  playtime are trust-based, using the player's token for that game. Hard rule: nothing that grants
  value may be triggered by trust-based data. (§7.0, §7.4, §7.5)
- **Deletion ledger** so restoring a backup can't bring deleted accounts back. Backups are
  encrypted and only readable by restoring onto the stack. (§4.12, §8.7)
- **Heavy metrics:** full metrics catalogue, and the observability profile moved into v1. (§8.6)
- **Smaller changes:**
  - Password max length is 256, and composition rules are optional in config.
  - "Don't log me out of other sessions" checkbox on password reset.
  - Last-sign-in-method warning text.
  - Guardian must approve their own removal.
  - App-wide toggle for new-device emails.
  - Toggle for public legal version history.
  - During a username release hold, the previous owner can reclaim the name.
  - Reserved username prefixes are config only.
  - CLI is named `qtiauth`.
  - Per-provider verified-email handling.
- **Rejected:** advance-notice emails for legal changes, and formal appeals (different-moderator
  rule, uphold/overturn/modify outcomes). Basic appeals remain.

---

## 1. Goals and non-goals

### 1.1 Goals

1. **Self-hosted, not serverless.** One Docker Compose stack.
2. **Pick your features.** Optional modules are Compose profiles.
3. **Open source and brand-neutral.** Nothing deployment-specific in code: brand, URLs, app names,
   legal text, taxonomies, limits and templates all live in config. Secrets live in `.env`.
4. **Security by construction.** The flaws found in the old system (token confusion, rate-limit
   bypass, ignored config) must be impossible by design, not just patched.
5. **UK Online Safety Act aware.** Safety features map to the duties that apply to small regulated
   services (§9).

### 1.2 Non-goals

- **Serverless or edge deployment.**
- **Multi-tenancy.** One deployment serves one brand. Run several stacks for several brands.
- **Social features, permanently:** friends, chat, DMs, public user-generated content. Adding them
  would bring the account platform itself into Online Safety Act scope as a user-to-user service,
  including the child-safety default measures (ICU F1/F2). Games that have chat carry that
  responsibility themselves and use the Safety intake API (§6.2). Any future feature that lets users
  see each other's content must be checked against this rule first.
- **Payments or a storefront.** Entitlements arrive by admin grant, key redemption, Steam ownership
  sync, or an authenticated API call from an external payment system (§7.2).
- **The frontend in the first phase.** The backend is built first, then the web app.

---

## 2. Architecture

### 2.1 Overview

```
                      ┌─────────────────────────────────────────────────────────┐
  browsers / games ──▶│ gateway   (surfaces, sessions, route policy,            │
  / game servers      │            rate limits, CORS, internal identity tokens) │
                      └───────┬───────────┬───────────┬───────────┬────────────┘
                              │ HTTP      │           │           │
             ┌────────────────┴┐  ┌───────┴──┐  ┌─────┴────┐  ┌───┴──────┐  ┌──────┐
             │ identity (core) │  │ oidc     │  │ safety   │  │ support  │  │games │
             └───────┬─────────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘  └──┬───┘
                     │                 │             │             │           │
       ══════════════╧═════════════════╧═════════════╧═════════════╧═══════════╧═══
                        NATS JetStream  (events + request/reply)
       ══════════════╤════════════════════════╤══════════════════════╤═════════════
                     │                        │                      │
              ┌──────┴─────┐          ┌───────┴──────┐        ┌──────┴─────┐
              │ notifier   │          │ scheduler    │        │ web        │
              │ email +    │          │ cron ticks   │        │ (SPA)      │
              │ webhooks   │          └──────────────┘        └────────────┘
              └────────────┘

   Infra: postgres (shared, schema-per-service) · valkey · nats
          [minio] · [geoip-updater] · [edge] · [backup] · [observability]
```

### 2.2 Services

| Service | Compose profile | Postgres schema | Purpose |
|---|---|---|---|
| `gateway` | always on | — | Single public entry point (§2.6) |
| `identity` | always on | `identity` | Accounts, all auth methods, sessions, age & parental consent, legal acceptance, usernames, text filter, admin users, RBAC, audit log |
| `notifier` | always on | `notify` | Email (provider abstraction), outbound webhooks, delivery logs |
| `scheduler` | always on | — | Publishes cron ticks onto the bus (§2.8) |
| `web` | always on | — | Merged frontend for all surfaces |
| `oidc` | `oidc` | `oidc` | OAuth 2.1 / OIDC provider and developer portal |
| `safety` | `safety` | `safety` | Reports, moderation, appeals, CSEA/NCA workflow |
| `support` | `support` | `support` | Tickets and knowledge base |
| `games` | `games` | `games` | Catalog, entitlements, keys, achievements, stats, leaderboards, playtime, cloud saves, licensing, Steam |
| `postgres` | always on | — | PostgreSQL 17+ |
| `valkey` | always on | — | Rate limits, session cache, short-lived state |
| `nats` | always on | — | NATS 2.11+ with JetStream |
| `minio` | `storage` | — | S3-compatible object storage. Any external S3 works instead |
| `geoip-updater` | `geoip` | — | Keeps the DB-IP Lite database current |
| `caddy` | `edge` | — | Optional TLS termination with automatic HTTPS |
| `backup` | `backup` | — | Scheduled encrypted backups (§8.7) |
| `prometheus`, `grafana`, `tempo`, `loki` | `observability` | — | Metrics, dashboards, traces, logs (§8.6) |

**Profiles vs sub-features.** Profiles choose which containers run. Smaller features inside a service
are config flags: individual auth methods, each social provider, the developer portal, licensing,
Steam, leaderboards, cloud saves, guest tickets, and so on.

**Consistency check.** On startup each service announces itself on `qtiauth.sys.announce`, and
announces again whenever anything publishes `qtiauth.sys.discover` (so a gateway that starts later
can ask). The gateway asks every `gateway.discovery.interval` and forgets an instance that hasn't
announced itself for `gateway.discovery.expiry`. The
gateway refuses config that enables a sub-feature whose service isn't running (for example
`features.games.licensing.enabled: true` without the `games` profile) and reports it at
`GET /api/v1/meta/health`.

### 2.3 Postgres

- **One shared instance, one schema per service.** Each service connects with its own role, which
  only has privileges on its own schema. **No cross-schema queries.** A service that needs another
  service's data asks over the bus or keeps a local read-model fed by events.
- Users are referenced across services by `user_id` (UUIDv7) only. There are no cross-schema foreign
  keys. Deletion propagates by event (§4.12).
- Postgres full-text search (`tsvector`) powers KB search and admin user search. There is no
  separate search engine.

**Migrations**

- Each service owns versioned, forward-only migrations for its own schema, shipped inside its image.
- **On startup** a service takes a Postgres advisory lock for its schema and applies any pending
  migrations (`migrations.auto_apply: true`, the default). **Upgrading one service's image migrates
  only that service's schema.** Nothing else needs restarting.
- With `migrations.auto_apply: false`, a service with pending migrations refuses to start and logs
  the exact command to run: `docker compose run --rm <service> qtiauth migrate up`.
- `qtiauth migrate status` / `qtiauth migrate up` are available in every service image.
- `qtiauth db provision` creates each service's role and schema, connecting as the Postgres
  administrator. It is safe to run again.
- **Expand/contract rule:** every migration must stay compatible with the previous release of the
  same service, so replicas can be upgraded one at a time. Destructive steps (dropping columns,
  tightening constraints) ship one release after the code stops using the old shape.
- Migrations never touch another service's schema. Contract changes between services go through
  versioned events: a `.v2` subject is published alongside `.v1` for at least one release.

### 2.4 Message bus: NATS JetStream

NATS covers both async events (JetStream streams) and synchronous service-to-service queries
(request/reply) with one small dependency.

**Domain events** (async, at-least-once, durable)

- Subject format: `qtiauth.<service>.<entity>.<verb>.v<n>`, e.g. `qtiauth.identity.user.banned.v1`.
- **Transactional outbox:** a service writes the event to its own `outbox` table in the same
  transaction as the state change. A relay publishes to JetStream and marks the row sent, so nothing
  is lost if the service crashes between commit and publish.
- Consumers are idempotent and deduplicate on `event_id`, recorded in the same transaction as the
  consumer's own changes.
- Each event type's `data` has a versioned JSON Schema in `packages/events`. Compatible additions
  (new optional fields) keep the version. Anything else is a new `.v<n+1>` type, published alongside
  the old one for at least one release.
- Envelope:
  ```json
  {
    "event_id": "01J…",
    "type": "qtiauth.identity.user.banned.v1",
    "occurred_at": "2026-09-16T12:00:00Z",
    "actor": { "type": "user|service|system", "id": "…" },
    "subject": { "type": "user", "id": "…" },
    "data": { },
    "trace_id": "…",
    "span_id": "…"
  }
  ```

**Request/reply** (sync)

- Subject format: `qtiauth.rpc.<service>.<method>`, e.g. `qtiauth.rpc.identity.get_user_summary`.
- Requests carry a deadline. Callers must degrade gracefully when an optional service isn't running.
  NATS returns "no responders" immediately, so this costs no timeout.

**Work queues** (async, durable, once per job)

- Subject format: `qtiauth.work.<service>.<queue>`, e.g. `qtiauth.work.notifier.email`. Only the
  owning service consumes its queues, and each job goes to one replica.

**Core event catalogue (initial)**

| Event | Main consumers |
|---|---|
| `identity.user.created` / `updated` / `deleted` | all services (read-models, erasure) |
| `identity.user.banned` / `unbanned` / `locked` / `unlocked` / `restricted` | gateway (cache bust), notifier, safety, oidc (back-channel logout) |
| `identity.user.age_band_changed` | games, oidc, notifier |
| `identity.session.created` / `revoked` / `flagged` | notifier (new-device email), gateway (cache bust), oidc (back-channel logout) |
| `identity.legal.version_published` | notifier (non-material change notice), gateway |
| `identity.parental.consent_requested` / `granted` / `revoked` / `removal_requested` | notifier |
| `safety.report.created` / `actioned` / `dismissed` / `sla_breached` | notifier (webhooks), identity (enforcement) |
| `safety.content.removal_requested` | games |
| `safety.csea.case_opened` | notifier (restricted alert channel only, §6.2) |
| `support.ticket.created` / `replied` / `status_changed` | notifier |
| `games.entitlement.granted` / `revoked` | notifier (webhooks) |
| `audit.recorded` | identity (audit store) |
| `sys.cron.<job>` | the service that owns the job |

### 2.5 Valkey

Used for rate-limit counters (sliding window), the session lookup cache, and short-lived state
(OAuth `state` / PKCE verifier during social login, magic-link throttles, session binding codes).
**Nothing in Valkey is a source of truth.** Wiping it logs nobody out, because sessions fall back to
Postgres.

### 2.6 Gateway

A purpose-built service, not just reverse-proxy config, because it enforces security policy.

1. **Surface routing.** Maps host and/or port to a surface, and mounts APIs per §2.10.
2. **Route table from manifests.** On startup each service publishes a route manifest (path, method,
   module, policy, permissions it defines) over the bus, as part of its announcement. The gateway
   builds its routing table from these, so a disabled service's routes don't exist. Each service
   also serves its OpenAPI document over `qtiauth.rpc.<service>.openapi` for the merged document.
   Two services declaring the same method and path on a surface is a conflict, and a route naming an
   unknown rate-limit policy is invalid. Neither kind of route is served, and both are reported at
   `GET /api/v1/meta/health`.
3. **Declared route policy.** Nothing is special-cased by path.
   ```yaml
   - method: POST
     path: /api/v1/support/tickets
     auth: session            # none | session | oauth | service | game_authoritative
     permissions: []          # RBAC permissions required
     scopes: []               # OAuth scopes required (auth: oauth / service)
     allow_account_states: [active, banned, locked]   # default: [active]
     allow_pending_legal: true                         # default: false
     allow_pending_parental_consent: false             # default: false
     rate_limit: ticket_create
     step_up: false           # require aal2 within security.step_up_window
   ```
4. **Session resolution.** Reads the surface's session cookie, resolves the binding and session
   through Valkey (falling back to `qtiauth.rpc.identity.resolve_session`), and runs session-security
   checks (§4.8).
   - `qtiauth.rpc.identity.resolve_session` takes `{ binding_token_hash, cookie_scope }` (the
     base64url SHA-256 of the cookie token, and `cookies.domain` or the request host) and answers
     `{ session: null }` or the session's ID, user ID, account state, permissions, restrictions, age
     band, parental controls, `amr`, `acr`, `step_up_at`, `legal_acceptance_required` and
     `expires_at`.
   - Resolved sessions are cached in Valkey for `gateway.session_cache.ttl`. The cache is cleared
     for a session or user by `identity.session.revoked` / `flagged`, the `identity.user.*` state
     events, parental consent changes, and for everyone by `identity.legal.version_published`.
   - Identity sets and clears the session cookie through response headers, since services never
     touch cookies: `X-QTIAuth-Session-Token` with `X-QTIAuth-Session-Expires` sets it,
     `X-QTIAuth-Session-Clear` clears it, and `X-QTIAuth-Revoked-Sessions` lists session IDs the
     gateway drops from its cache before answering, so a revocation made through the gateway takes
     effect on the next request. The gateway only honours these headers from identity and strips
     them from every response.
5. **Internal identity token.** For each proxied request the gateway mints a 60-second EdDSA JWT in
   `X-QTIAuth-Identity`. It holds user ID, session ID, permissions, account state, restrictions,
   age band, parental controls and auth context (`amr`, `acr`). Services verify it with the gateway's
   public key, **never** read cookies or bearer tokens themselves, and reject any request without it,
   on top of network isolation.
   - The signing keys are Ed25519, kept in the NATS key-value bucket `qtiauth_gateway` so every
     gateway replica shares them, and envelope-encrypted with `KEY_ENCRYPTION_KEY`
     (`gateway.identity_keys.encryption_key`). The `keys.rotate` job replaces the key once it's
     `gateway.identity_keys.rotate_after` old, and the replaced key stays published for
     `gateway.identity_keys.retain_after_rotation`.
   - Header `{ alg: EdDSA, typ: qtiauth-identity+jwt, kid }`. Claims: `iss` (`qtiauth-gateway`),
     `aud` (the target service's name), `iat`, `exp`, `jti`, `request_id`, `auth` (the route's auth
     mode), `sub`, `sid`, `client_id`, `scopes`, `permissions`, `account_state`, `restrictions`,
     `age_band`, `parental_controls`, `amr`, `acr`. Absent values are `null` or `[]`.
   - Services fetch the gateway's current public keys (a JWKS) over
     `qtiauth.rpc.gateway.identity_keys`, cache them for `service.identity_tokens.keys_refresh`, and
     fetch again straight away when a token names a key they haven't seen.
   - A service refuses a token for another audience, one with a lifetime over 60 seconds, or one
     outside its validity window by more than `service.identity_tokens.clock_tolerance`.
   - As defence in depth, services also check the route's auth mode, permissions, scopes and allowed
     account states against the token. The gateway remains responsible for rate limits, step-up and
     the legal and parental gates.
6. **Rate limiting** on every route, including all auth routes (§8.1).
7. **CORS** from config, plus automatic entries for sibling surface origins (§2.10).
8. **Security headers,** request IDs, trace propagation, trusted-proxy client IP extraction.
9. **Legal / parental gates.** Returns `403 LEGAL_ACCEPTANCE_REQUIRED` or
   `403 PARENTAL_CONSENT_PENDING` unless the route policy allows the request through.

**TLS** is not handled by the gateway. Terminate it in your own reverse proxy, or enable the `edge`
profile (Caddy with automatic HTTPS).

### 2.7 Authentication model

First-party sessions and third-party tokens are completely separate.

| Caller | Credential | Accepted on |
|---|---|---|
| First-party web app | **Opaque session cookie** (`HttpOnly`, `Secure`, `SameSite=Lax`, `__Host-` prefix unless a shared cookie domain is configured) | `auth: session` routes only |
| Third-party apps, game clients | **OAuth access token** (JWT, RFC 9068, `aud` = resource) | `auth: oauth` routes only, scope-checked |
| Game servers, external backend systems | **OAuth client-credentials token** | `auth: service` routes only, scope-checked |
| Game server submitting leaderboard scores for a signed-in player | **Game server token + player access token** together (§7.5) | `auth: game_authoritative` routes only |
| Service to service | Gateway-minted internal token, or NATS (network-isolated) | Internal only |

- Session tokens are **not JWTs**. They're 256-bit random values stored hashed (SHA-256), so there's
  nothing to forge and revocation is immediate.
- The first-party web app never uses `Authorization: Bearer` session tokens, so session tokens are
  never readable by JavaScript.
- CSRF: `SameSite=Lax`, plus an `Origin` check on every state-changing request. A state-changing
  request carrying a session cookie without an `Origin` header is refused.

### 2.8 Scheduler

`scheduler` publishes `qtiauth.sys.cron.<job>` on the schedule set in config. Each job is consumed
by exactly one instance of the owning service (JetStream work-queue consumer), so replicas never
double-run a job. The scheduler holds no job logic.

- Schedules are cron patterns in `scheduler.jobs.<job>.schedule` (five fields, or six with seconds
  first), read in `scheduler.timezone` (default `UTC`). Config overrides a built-in job's schedule or
  `enabled` flag, and can add jobs.
- Each tick carries `{ job, scheduled_at }` and uses `<job>@<scheduled_at>` as its JetStream message
  ID, so several scheduler replicas can run without duplicating ticks.
- A failed publish is retried within `bus.streams.duplicate_window` and before the job's next tick,
  then dropped. Ticks due while the scheduler is down are not caught up.

| Job | Owner | Default schedule |
|---|---|---|
| `retention.sweep` | every service | daily 03:00 |
| `parental.expire_pending` | identity | hourly |
| `accounts.purge_deleted` | identity | daily 03:30 |
| `age.recompute_bands` | identity | daily 00:05 |
| `accounts.unlock_expired` | identity | every minute |
| `legal.publish` | identity | every minute |
| `accounts.resume_exports` | identity | every 5 minutes |
| `deletion_ledger.prune` | identity | daily 04:00 |
| `keys.rotate` | gateway, oidc, games | daily 00:00 (rotates when due) |
| `webhooks.retry` | notifier | every minute |
| `support.auto_close` | support | hourly |
| `achievements.recompute_rarity` | games | daily 02:00 |
| `leaderboards.reset_periodic` | games | every minute (resets leaderboards whose period has ended, per leaderboard config) |
| `steam.ownership_sync` | games | daily 05:00 |
| `backup.run` | backup | daily 02:30 |

### 2.9 Replacing the Cloudflare-specific pieces

| Cloudflare feature | Replacement |
|---|---|
| D1 | PostgreSQL 17+ (§2.3) |
| Cron Triggers | `scheduler` (§2.8) |
| `cf-connecting-ip` | Gateway `network.trusted_proxies` CIDR list plus `X-Forwarded-For` parsing (rightmost untrusted hop). Without trusted proxies the socket peer address is used. XFF is never trusted blindly. |
| `cf-ipcountry` | Local GeoIP lookup. **Default: DB-IP "IP to Country Lite"** (CC-BY 4.0, no account needed), refreshed monthly by `geoip-updater`. Alternatives: MaxMind GeoLite2 (free licence key), or `geoip.source: header` to trust an upstream proxy's header. With no GeoIP source, country checks switch off and the admin health page warns. |
| `cf-ja3` / `cf-ja4` | Off by default. `session_security.tls_fingerprint.header` accepts a JA4 value from a proxy that computes it. Low weight in trust scoring. |
| Workers secrets | `.env`, plus Docker secrets via `${file:/run/secrets/…}` (§3.2) |
| Cloudflare Pages | `web` container |
| Workers observability / `wrangler tail` | JSON logs, OpenTelemetry, Prometheus metrics, `observability` profile (§8.6) |
| Brevo `fetch` | `notifier` provider abstraction (§5.1) |
| Implicit edge rate limiting | Gateway + Valkey (§8.1) |

### 2.10 Surfaces, hosts and sessions

A single `web` app contains every browser experience. It's served on three **surfaces**. Each can
be bound to any combination of hostnames and ports and owns a set of modules.

| Surface | Default modules | Purpose |
|---|---|---|
| `account` | identity, oidc (consent screen, authorized apps, developer portal), games, safety, admin | Main account site. **Primary surface** for signing in |
| `support` | support (tickets, KB, staff support UI) | Help centre |
| `api` | all enabled modules, plus `/oauth/*` and `/.well-known/*` at its root | Non-browser clients: games, game servers, third-party apps |

```yaml
# Everything on one host
surfaces:
  account: { hosts: [me.example.com], base_path: / }
  support: { hosts: [me.example.com], base_path: /support }
  api:     { hosts: [me.example.com], base_path: /api }
```

```yaml
# Split hosts, even across different registrable domains
surfaces:
  account: { hosts: [account.example.co.uk], base_path: / }
  support: { hosts: [support.example.com],   base_path: / }
  api:     { hosts: [auth.example.co.uk],    base_path: / }
```

```yaml
# Port-based (internal/LAN)
surfaces:
  account: { ports: [8080], base_path: / }
  support: { ports: [8081], base_path: / }
  api:     { ports: [8082], base_path: / }
```

Module ownership can be overridden per surface with `surfaces.<name>.modules`. Each surface's
public origins default to `https://<host>` for each host, and can be set with
`surfaces.<name>.origins` (needed for surfaces bound only to ports, or served over another scheme or
port).

**API mounting**

- **The core API** (identity and meta: `/api/v1/me`, auth, sessions, legal, notification
  preferences, `/api/v1/meta/*`) is mounted on **every** web surface at `<surface base>/api`.
- On the `api` surface, a route's `/api` prefix is replaced by the surface's base path, so with
  `base_path: /api` the core API is at `/api/v1/…`, and with `base_path: /` at `/v1/…`.
- **Module APIs are mounted only on the surface that owns them.** If the account app needs support
  data, it calls the support surface's host and base path, never a duplicate mount on the account
  surface.
- The gateway automatically adds every surface's origin to the credentialed CORS allowlist, so
  cross-surface calls work without manual CORS config.
- **Browser limitation:** credentialed cross-surface `fetch` calls only work when both surfaces are
  **same-site** (same host, or the same registrable domain, e.g. `account.example.com` ↔
  `support.example.com`). Across different registrable domains (`example.co.uk` ↔ `example.com`),
  browsers block cookies on cross-site requests. In that setup the frontend must **link or
  navigate** to the other surface rather than load its data inline. `GET /api/v1/meta/features`
  reports whether each surface pair is same-site, and the admin health page lists cross-site pairs.

**One session everywhere**

A user has **one session** no matter how many surfaces or domains they use it on.

- A session is one server-side record. It appears once in the session list, and revoking it or
  logging out on any surface ends it on **every** surface immediately.
- Each distinct cookie scope holds a **binding**: a random token in that host's own cookie, pointing
  at the shared session. Surfaces on the same host, or under a configured shared `cookies.domain`,
  share a single binding.
- **Silent binding** (no user interaction):
  1. A surface receives a request with no binding cookie and needs a session. It sends a top-level
     redirect to the primary surface:
     `account/auth/bind?target=<surface>&return=<path>`.
  2. If the user is signed in there, identity issues a single-use code (60 s TTL, bound to the target
     origin and return path) and redirects to `<surface>/auth/bind/callback?code=…`.
  3. The target surface's gateway exchanges the code and sets its own cookie for the **same**
     session.
  4. If the user isn't signed in on the primary surface, step 1 lands on the login page there and
     bounces back after sign-in.
- This works across different registrable domains, because every step is a top-level navigation and
  each cookie is first-party on its own host.
- **Assurance level (aal2 / step-up) belongs to the session**, so it carries across surfaces.
- After logout or revocation, stale binding cookies on other hosts are cleared on their next request.
- To avoid a redirect loop, a surface that has just attempted binding and failed serves its
  signed-out view instead of redirecting again.

**Feature discovery:** `GET /api/v1/meta/features` returns enabled modules and sub-features, auth
methods, surfaces (origins, base paths, owned modules, same-site pairs) and branding, so the frontend
never hardcodes what exists.

### 2.11 Object storage

S3-compatible: the bundled MinIO (`storage` profile) or any external S3/R2/B2.
It's used by support attachments, KB images, cloud saves, and user data exports.
Enabling any of those without storage configured fails config validation.
Uploads and downloads use presigned URLs, and file bodies never pass through the gateway.

---

## 3. Configuration

### 3.1 Layout

```
config/
  qtiauth.yaml             # the one main config file
  qtiauth.dev.yaml         # development config (console email), used by the Compose dev override
  legal/
    terms.md               # front-matter: id, version, effective_at, material, summary
    privacy.md
    children-summary.md    # optional plain-language version for under-18s
  templates/
    email/<locale>/        # overridable MJML + text email templates
  lists/
    username/
      ldnoobw.txt           # vendored at a pinned commit (§4.11)
      dictionary.txt
      names.txt
      surnames.txt
      places.txt
      allow.txt
      extra-block.txt
  branding/
    logo.svg
    favicon.ico
.env                       # secrets only
```

### 3.2 Rules

- **Everything that isn't a secret goes in `qtiauth.yaml`:** brand and company name, support email,
  surfaces and hosts, cookie settings, CORS, first-party OAuth clients (names, redirect URIs), OAuth
  scopes and their consent text, report taxonomy and SLAs, moderation action types and rules, ticket
  categories, rate limits, retention periods, age bands and thresholds, username rules (including
  reserved names and prefixes), password policy, email templates, webhook defaults, game settings,
  Steam apps.
- **Secrets only in `.env`**, referenced as `${env:NAME}`. Any value can instead be read from a file
  with `${file:/run/secrets/name}` for Docker secrets.
- **Validated at startup** against a published JSON Schema. Invalid config stops the service with a
  precise error path. `qtiauth config check` validates without starting anything.
- **Nothing hardcoded.** CI fails if a deployment-specific literal appears in source: production
  domains, company names, brand strings, reserved username prefixes such as `QTI_`. The project name
  "QTIAuth" is not deployment-specific and is allowed.
- **Shipped defaults are brand-neutral** (`Example`, `example.com`, no reserved prefixes). Quiet
  Terminal's production values live in a separate private config.

### 3.3 Skeleton

```yaml
branding:
  product_name: "Example Account"
  company_name: "Example Ltd"
  support_email: "support@example.com"
  logo: ./branding/logo.svg
  colors: { primary: "#3b82f6" }

surfaces: { … }                 # §2.10
cookies:
  name: qtiauth_session         # __Host- prefix is added when domain is null
  domain: null                  # optional shared cookie domain; null → host-only __Host- cookies
  session_ttl: 7d
  idle_timeout: 30d

cors:
  allowed_origins: []           # surface origins are added automatically

network:
  trusted_proxies: []

geoip:
  source: dbip_lite             # dbip_lite | maxmind | header | none
  header: null

database:
  host: postgres
  name: qtiauth
  roles:                        # one role per service schema (§2.3)
    identity: { user: qtiauth_identity, password: "${env:DB_IDENTITY_PASSWORD}" }
    # notify, oidc, safety, support, games likewise
  audit: { user: qtiauth_audit, password: "${env:DB_AUDIT_PASSWORD}" }  # INSERT/SELECT on identity.audit_log (§4.15)

migrations:
  auto_apply: true

bus:
  servers: [nats://nats:4222]
  user: null
  password: "${env:NATS_PASSWORD}"
  streams:  { replicas: 1, events_max_age: 7d }
  consumers: { max_deliver: 10, dedupe_retention: 14d }

observability:
  logs:    { level: info, user_id_hash_key: "${env:LOG_USER_ID_HASH_KEY}", redact_keys: [] }
  tracing: { enabled: false, endpoint: http://tempo:4318/v1/traces, sample_ratio: 1 }
  metrics: { process_metrics: true }
  health:  { check_timeout: 2s }

service:                        # shared by every service
  http: { port: 8080, shutdown_timeout: 15s }
  identity_tokens: { clock_tolerance: 5s, keys_refresh: 5m }

valkey:
  host: valkey
  password: "${env:VALKEY_PASSWORD}"

gateway:
  http: { port: 8000, max_body_size: 1048576, upstream_timeout: 30s }
  upstreams: {}                 # default http://<service>:<service.http.port>
  discovery: { interval: 30s, expiry: 90s, startup_grace: 5s }
  session_cache: { ttl: 1m }
  identity_keys: { encryption_key: "${env:KEY_ENCRYPTION_KEY}", rotate_after: 30d, retain_after_rotation: 1h }
  hsts: { max_age: 365d, include_subdomains: false, preload: false }

scheduler:
  timezone: UTC
  jobs:                         # built-in jobs and schedules in §2.8
    retention.sweep: { schedule: "0 3 * * *", enabled: true }

features:
  auth:
    password:   { enabled: true }
    magic_link: { enabled: true }
    passkeys:   { enabled: true }
    totp:       { enabled: true }
    social:
      google:  { enabled: false, client_id: "${env:GOOGLE_CLIENT_ID}", client_secret: "${env:GOOGLE_CLIENT_SECRET}" }
      github:  { enabled: false }
      discord: { enabled: false }
      steam:   { enabled: false }
      generic_oidc: []          # [{ id, name, issuer, client_id, client_secret, scopes, icon }]
  session_security: { enabled: true }
  oidc:
    developer_portal: { enabled: true }
    backchannel_logout: { enabled: true }
  games:
    licensing:    { enabled: true }
    steam:        { enabled: false }
    leaderboards: { enabled: true, require_game_authority: true }
    playtime:     { enabled: true }
    cloud_saves:  { enabled: false }
    keys:         { enabled: true }
  support:
    tickets:       { enabled: true }
    kb:            { enabled: true }
    guest_tickets: { enabled: true }
    attachments:   { enabled: false }

captcha:
  provider: altcha              # altcha | turnstile | hcaptcha | friendly_captcha | none

email:
  provider: smtp                # smtp | brevo | postmark | ses | resend | mailgun | console
  from:
    auth:     { name: "Example Auth",     address: "auth@example.com" }
    security: { name: "Example Security", address: "security@example.com" }
    support:  { name: "Example Support",  address: "support@example.com" }
  default_locale: en-GB
  templates_dir: templates/email  # relative to the config directory (§5.1)
  smtp: { host: localhost, port: 587, security: starttls, user: null, password: "${env:SMTP_PASSWORD}" }
  queue: { max_attempts: 20, retry_delay: 10s, max_retry_delay: 30m }

accounts:                       # §4.1, §4.12
  max_per_email: 2
  email_normalization:          # per domain; case is always ignored
    gmail.com:      { remove_dots: true, subaddress_separator: "+", domain: null }
    googlemail.com: { remove_dots: true, subaddress_separator: "+", domain: gmail.com }
magic_link: { ttl: 15m, signup_ttl: 30m }  # §4.3
sessions:   { max_per_user: 10 }  # §4.8
password:   { … }               # §4.2
security:   { step_up_window: 10m, … }   # §4.5
age:        { bands: { 13_to_15: 13, 16_to_17: 16, adult: 18 }, … }   # §4.6
parental:   { consent_age: 13, … }       # §4.7
session_security: { … }         # §4.8
legal:      { … }               # §4.9
usernames:  { … }               # §4.10
safety:     { … }               # §6.2
rate_limits: { … }              # §8.1
retention:  { delivery_logs: 30d, sessions: 30d, tokens: 24h, … }   # §8.4
backups:    { … }               # §8.7
```

---

## 4. Identity service (core)

### 4.1 Accounts

- UUIDv7 user IDs.
- **Account states** (a single explicit state machine): `pending_email_verification`,
  `pending_parental_consent`, `active`, `locked`, `banned`, `pending_deletion`, `deleted`.
- **Email** is stored as entered plus a normalized form. Normalization rules (e.g. Gmail dot and
  plus stripping) are defined per domain in config.
- **`accounts.max_per_email`** limits accounts per normalized email (default `2`).
- **Multiple sign-in methods per account.** An `identities` table holds `password`, `magic_link`,
  `passkey`, `google`, `github`, `discord`, `steam` and `oidc:<id>` identities. One account can use
  any combination.
  - **Connecting a social identity** only happens when the user is signed in and explicitly chooses
    it (e.g. "Connect Google"). It's never automatic, even when emails match, because automatic
    linking by email is an account-takeover vector.
  - **A user can't remove their last sign-in method.** Trying to shows:
    > This is your last available sign-in method. Either add another to remove this one or, if you
    > are attempting to delete your account, go to [Delete account](…).
- **Change email:** requires step-up. A confirmation link goes to the new address, and a notice goes
  to the old one with a 7-day "this wasn't me" revert link.
- `GET /api/v1/me`, `POST /api/v1/auth/logout`.

### 4.2 Password authentication

- **Signup:** the user picks "Sign up with password" or "Sign up with magic link". Both require email
  verification before the account becomes `active`.
- **Add a password later:** accounts without one can set a password in settings. No current password
  is needed, but step-up (magic link or passkey) is.
- **Change password:** requires the current password or step-up.
- **Forgot password:** an emailed single-use reset link (15 min). The reset form has a
  **"Don't log me out of other sessions"** checkbox, **unticked by default**, so resetting normally
  revokes every other session.
- **Hashing:** Argon2id, parameters in config (defaults per OWASP: m=19 MiB, t=2, p=1). Rehash on
  login when parameters change.
- **Policy:**
  - `password.min_length` (default 10) and `password.max_length` (default and hard cap 256).
  - **Composition rules are optional** and off by default:
    `password.composition: { require_lower: false, require_upper: false, require_digit: false, require_symbol: false }`.
  - **Breached-password check** through the Have I Been Pwned k-anonymity range API
    (`password.breach_check: true`). Only the first 5 hex characters of the SHA-1 hash leave the
    server. Fails open if HIBP is unreachable.
  - Passwords equal to or containing the email local part or username are rejected.
- **Credential-stuffing protection:** per-account and per-IP failure counters with progressive delay,
  then CAPTCHA (§8.2). There is **no hard lockout**, because that would let an attacker lock anyone
  out.
- **Generic failure message** ("Email or password incorrect"). Login timing is equal whether or not
  the account exists.

### 4.3 Magic link

- `POST /api/v1/auth/magic-link/start`, `POST /api/v1/auth/magic-link/verify`.
- Hashed single-use token, 15-minute expiry (config).
- Default rate limits: 3/hour per email, 10/hour per IP, 20/day per IP (§8.1).
- **Identical response whether or not an account exists** ("If an account exists, we've sent a
  link").
- **For signup, DOB is collected after the link is clicked.** This hides account existence and means
  DOB is never stored against an unverified email.
- **Scanner-safe:** opening the link shows a "Confirm sign-in" page and needs a click (POST), so
  email security scanners that pre-fetch links don't use up the token.
- The link points at `/auth/magic-link?token=…` on the account surface's first origin. Using it
  (`verify`, `{ token, user_id? }`) looks up accounts by normalized email only then:
  - one account: signs in and answers `signed_in`.
  - several accounts: answers `choose_account` with their IDs and creation dates, without using the
    token, until `user_id` names one of them.
  - no account: uses the token and answers `signup_required` with a single-use `signup_token`
    (`magic_link.signup_ttl`). `POST /api/v1/auth/magic-link/signup` with
    `{ signup_token, date_of_birth }` creates the account, enforcing `accounts.max_per_email`, and
    signs in.
- Using a link or a signup token is rate-limited by `auth_verify` (§8.1).

### 4.4 Social and upstream sign-in

- **Providers:** Google, GitHub, Discord, **Steam** (OpenID 2.0), and **generic OIDC upstreams**
  (any standards-compliant IdP such as Authentik, Keycloak, Microsoft Entra or Apple, added purely in
  config).
- Each provider is individually toggled. Enabling one with missing credentials fails config
  validation, not the first login.
- CSRF `state`, PKCE where supported, and `nonce` for OIDC providers. State lives in Valkey with a
  10-minute TTL.
- New users without a birthdate from the provider go through the DOB step.
- **Only verified provider emails are trusted:**

  | Provider | Verification signal |
  |---|---|
  | Google | `email_verified` claim |
  | GitHub | `verified: true` on the primary address from `/user/emails` |
  | Discord | `verified` field on the user object (requires the `email` scope) |
  | Steam | Provides no email. The user must enter and verify one |
  | Generic OIDC | `email_verified` claim. Missing or `false` counts as unverified |

  An unverified or missing provider email is never used as-is. QTIAuth sends its own verification
  email before the address is attached to the account.

### 4.5 Passkeys and two-factor

- **Passkeys (WebAuthn):** usable as a primary passwordless sign-in or as a second factor. Multiple
  per account, each with a user-given name and last-used time.
- **TOTP** (RFC 6238). The secret is encrypted at rest with `APP_ENCRYPTION_KEY` from `.env`.
- **Recovery codes:** 10 single-use codes, stored hashed, regenerable.
- **Assurance levels:** `aal1` (one factor), `aal2` (two factors, or a passkey). Route policies can
  require step-up (aal2 within `security.step_up_window`, default 10 min). Step-up is required for
  changing email or password, deleting the account, creating or regenerating an OAuth client secret,
  exporting key batches, and **every admin action**.
- **Mandatory 2FA for staff:** `security.require_2fa_for_permissions` (default: every admin, safety
  and support-staff permission). Staff without 2FA can sign in but only reach the enrolment page.

### 4.6 Age

- **Date of birth is required** at signup.
- **Age band is computed, never stored as a flag.** DOB is stored and the band is derived at login
  and daily: `under_13`, `13_to_15`, `16_to_17`, `adult` (boundaries in config). A band change emits
  `identity.user.age_band_changed`.
- **Pluggable age assurance:**
  ```ts
  interface AgeAssuranceProvider {
    id: string;                                   // "self_declared", "yoti", …
    strength: "self_declared" | "estimated" | "verified";
    begin(user, ctx): Promise<BeginResult>;       // may redirect to a vendor
    complete(user, callbackPayload): Promise<AgeAssuranceResult>;
  }
  ```
  - Ships with `self_declared` only.
  - Config: `age.assurance.default_provider`, plus `age.assurance.required_for`, a list of triggers
    (e.g. `[claim_adult_band]`) for deployments that need highly effective age assurance.
  - Every result is recorded (provider, strength, timestamp, vendor reference, **never** identity
    documents) as evidence of the method used.
- **DOB changes** are staff-only, audited, and need a reason. Users can't edit their own DOB after
  signup.
- **Under-18 defaults** (ICO Age Appropriate Design Code): public profile off, leaderboard visibility
  off (§7.5), and security notifications always on.

### 4.7 Parental consent for under-13s

**Threshold:** `parental.consent_age` (default `13`, the UK GDPR Article 8 age. Some EU countries use
up to 16).

**Signup**

1. A user under `consent_age` enters a **parent/guardian email** during signup.
2. The account is created as `pending_parental_consent`. The child can sign in but only sees a
   "waiting for your parent or guardian" page, which lets them resend or change the guardian email
   (max 3 changes).
3. The guardian receives an email explaining the service and the data collected, linking the
   children's privacy summary, with **Approve** and **Decline**.
4. **Approve:** the guardian confirms their own DOB as an adult (upgradeable to real age assurance via
   §4.6) and accepts terms on the child's behalf. The account becomes `active`.
5. **Decline, or no response** within `parental.pending_ttl` (default 14 days): the account and its
   data are deleted.

**Guardian access**

- A **Family dashboard**, usable via magic link without a full account, or linked to the guardian's
  own account if they have one.
- Up to `parental.max_guardians` (default 2) per child.

**Guardian controls**

| Control | Effect |
|---|---|
| **Approve third-party apps** | The child can't grant OAuth consent to a non-first-party client. The request goes to a guardian and is authorized only once approved. |
| **Game restrictions** | Exposed to games through the internal token and the `parental_controls` claim: `online_play`, `in_game_chat`, `user_generated_content`, `purchases`, `daily_playtime_minutes`. Games enforce them. |
| **Leaderboards / public profile** | Off by default. The guardian can enable them. |
| **Sessions** | View the child's sessions and devices, and revoke any of them. |
| **Activity summary** | Weekly email plus dashboard: sign-ins, games played, playtime, apps connected. **No content.** |
| **Username changes** | Require guardian approval. |
| **Data rights** | Request a data export or account deletion for the child. |

**Guardian notifications:** new-device sign-in, new app connected, moderation action on the child's
account, and legal document changes.

**Graduation**

- When the child reaches `consent_age`, the child and guardian are both notified. Controls stay in
  place for `parental.graduation_grace` (default 30 days), then become optional.
- **Removing the guardian link needs both sides:** the young person requests it, and a guardian must
  approve. Guardians get reminders while a request is pending.
- **At the `adult` band** the user can remove the guardian link without approval, and guardians are
  notified.

### 4.8 Sessions and session security

- **Server-side sessions** with hashed opaque tokens and per-host bindings (§2.10).
- **Session list:** device, approximate location, auth method, last active, current marker.
- Revoke one, revoke all others, revoke all: `GET /api/v1/sessions`,
  `DELETE /api/v1/sessions/:session_id`, `POST /api/v1/sessions/revoke-others`,
  `POST /api/v1/sessions/revoke-all`.
- `sessions.max_per_user` (default 10). The oldest session is evicted when the limit is exceeded.
- **Idle timeout** (`cookies.idle_timeout`) plus absolute expiry (`cookies.session_ttl`).
- **Security event log** with rate-limited security alert emails.
- **Session security** (`features.session_security.enabled`):
  - **Signals:** IP, IP subnet (/24 IPv4, /48 IPv6), GeoIP country, User-Agent, optional TLS
    fingerprint header. Client-supplied timezone/screen/fingerprint headers are low-weight, because
    the client controls them.
  - **Trust levels:** `full` → `partial` → `challenge` → `blocked`.
  - **Country change policy** `session_security.on_country_change`:
    - `challenge` (**default**): the session drops to `aal0` until the user re-authenticates with a
      magic link, passkey, or password + 2FA.
    - `block`: revoke the session and send a security alert.
    - `notify`: allow, and send a security alert.
    - `ignore`.
- **New-device sign-in email** ("New sign-in from Chrome on Windows, near London, UK"). Users can't
  disable it individually. The deployment can turn it off app-wide with
  `session_security.new_device_email: false`.

### 4.9 Legal documents and re-acceptance

- Terms, privacy policy and any other documents live in `config/legal/*.md`:
  ```yaml
  ---
  id: terms
  version: 2026-10-01
  effective_at: 2026-10-01T00:00:00Z
  material: true           # true → users must re-accept
  summary: "We added passkeys and changed how long we keep security logs."
  ---
  ```
- On startup, identity syncs documents into the DB as **immutable versions**. Changing a published
  version's body without bumping `version` is a startup error.
- **Acceptance** is recorded per user per version (timestamp, IP, method).
- **Material change:** once `effective_at` passes, users who haven't accepted get
  `403 LEGAL_ACCEPTANCE_REQUIRED` on every route except those with `allow_pending_legal: true`:
  view and accept documents, log out, export data, delete account, open a support ticket.
- **Non-material change:** users are notified once it takes effect. No gate.
- **Child accounts:** material changes go to the guardian for acceptance. The child sees
  `children-summary.md` if it exists.
- **Version history:** previous versions are publicly viewable at `/legal/<id>/<version>` when
  `legal.public_history: true` (default `true`).

### 4.10 Usernames

- **Claim once after signup.** Accounts can exist without a username.
- **Changes:** cooldown (default 30 days) and yearly limit (default 3), with full history. All in config.
- **Rules** in config: length (default 8–18), character set (default `[A-Za-z0-9_]`),
  case-insensitive uniqueness via a canonical form.
- **Reserved names and prefixes** in config, empty by default:
  `usernames.reserved: []`, `usernames.reserved_prefixes: []`.
  (For example, Quiet Terminal's production config sets `reserved_prefixes: ["QTI_"]`.)
- **Release hold:** a released username is held for `usernames.release_hold` (default 90 days). During
  the hold **the previous owner can reclaim it**, and nobody else can claim it.
- Every username goes through the text filter (§4.11). Rejections say "Username not available".

### 4.11 Text filter (core library)

**Where it runs:** usernames, OAuth client names and descriptions, guardian display names, KB titles
(warning only), and any other field that becomes publicly visible. It lives in core because usernames
need it on every deployment.

#### Word lists

| Set | Contents | Source |
|---|---|---|
| **B_exact** | LDNOOBW entries that are ordinary English words or ≤ 3 characters. **Whole-token match only.** | Derived: `{ w ∈ LDNOOBW : w ∈ D_english or len(w) ≤ 3 }` |
| **B_loose** | All other LDNOOBW entries (most slurs and explicit compounds). Whole token, or padded inside a non-dictionary string. | `LDNOOBW − B_exact` |
| **B_extra** | Deployment-specific additions | `extra-block.txt` + admin UI |
| **D** | English dictionary, given names, surnames, place names. **This is what saves Scunthorpe.** | SCOWL (size 70); ONS and US SSA given-name lists; a surname list; GeoNames `cities15000` + first-level admin regions (CC-BY 4.0) |
| **A** | Small hand allowlist of false positives actually encountered | `allow.txt` + admin UI |

**LDNOOBW handling**

- Source: `LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words`. Usernames are not
  locale-specific, so every language file at the pinned commit is merged (`tlh` omitted).
- **Vendored at a pinned commit** and never fetched at runtime. Update with
  `qtiauth lists update --ldnoobw <commit>`.
- Spaces are removed from multi-word entries (`two girls one cup` → `twogirlsonecup`).
- `qtiauth lists audit` prints **every word in D that contains a B substring**, so missing places and
  surnames can be added to D before they cause false positives. Run it whenever LDNOOBW is updated.
- Short words and English dictionary entries stay in **B_exact** (whole-token only), so merging
  other languages does not turn `con` into a substring match.

#### Normalization

1. Unicode NFKC.
2. Strip zero-width and bidi control characters.
3. Map confusables to ASCII (Unicode TR39 skeleton).
4. Lowercase.
5. Small leet map: `0→o`, `3→e`, `4→a`, `5→s`, `7→t`, `@→a`, `$→s`.
   **Never map `1 → i`** (breaks `user1`). **Never collapse repeated letters** (breaks `assassin`).

#### Pipeline

```
normalize → whole string in A?  → ALLOW
          → whole string in B?  → BLOCK        (B = B_exact ∪ B_loose ∪ B_extra)
          → whole string in D?  → ALLOW        ← Scunthorpe stops here
          → tokenize (split on _, digits, camelCase), collapse single-character runs (c_u_n_t → cunt)
          → each token: in A or D → skip; in B → BLOCK; padded around a B_loose word → BLOCK
          → whole string padded around a B_loose word → BLOCK
          → otherwise ALLOW and log as unknown
```

```
function filter(raw):
    s = normalize(raw)

    if s in A:  return ALLOW("allowlist")
    if s in B:  return BLOCK("exact_block")
    if s in D:  return ALLOW("dictionary")

    for t in collapse_singletons(tokenize(raw)):
        t = normalize(t)
        if t in A or t in D: continue
        if t in B:                    return BLOCK("token_block")
        if padded_with(t, B_loose):   return BLOCK("token_padded_loose")

    if padded_with(s, B_loose):       return BLOCK("padded_loose")
    log_unknown(raw)
    return ALLOW("unknown")

function padded_with(t, bucket):
    for b in bucket, longest first:
        if b not in t: continue
        remainder = strip_padding(t without b)   # padding: digits, _ - . and runs of x
        if remainder is empty: return true       # xxxslurxxx, slur123
    return false
```

- `Scunthorpe` is in D, so it's allowed before any substring search.
- `xxx<slur>xxx` isn't in D, and only padding is left after removing the slur, so it's blocked.
- `c_u_n_t` collapses to a single token in B, so it's blocked.
- `classic` never matches `ass`, because `ass` is B_exact and B_exact is never substring-matched.

#### Rules

- **Never** find-and-replace (the `clbuttic` problem).
- **Never** fuzzy, edit-distance or Soundex match on short tokens (`ass` ≈ `ask` ≈ `pass`).
- **Never** substring-match B_exact.
- **Reject, don't rewrite.**
- **Log every decision** in `filter_decisions` (input hash, normalized form, rule fired, matched
  entry, context). The admin UI shows recent blocks and unknowns for tuning. Raw input is kept for
  30 days.

### 4.12 Account lifecycle and data rights

Required under UK GDPR.

- **Data export:** every enabled service contributes its part over the bus
  (`qtiauth.rpc.<service>.export_user`, which takes `{ user_id }` and answers
  `{ service, data }`). The result is zipped JSON in object storage, with a download
  link emailed that expires in 7 days. Without storage, the export is emailed as an attachment when
  it's under the size limit. Otherwise export is unavailable, and the admin health page warns.
- **Account deletion:** requires step-up. The account moves to `pending_deletion` for
  `accounts.deletion_grace` (default 30 days) and is signed out everywhere. Signing in cancels the
  deletion. When the grace period ends, `identity.user.deleted` is emitted and every service erases
  or anonymizes the user's data, including objects in storage, in a durable `user_erasure` consumer
  that reads every `identity.user.deleted` event still in the stream.
- **Legal holds:** Safety can place a hold (e.g. an open CSEA case). Held data is kept isolated and
  access-restricted, and everything else is deleted.
- **No deactivation state.** Accounts are kept or deleted.
- **Deletion ledger:**
  - When erasure completes, an entry `{ user_id, deleted_at }` (no other personal data) is appended to
    the deletion ledger.
  - **The ledger lives at the backup destination, not in the main database**, so it's always newer
    than any backup. Entries are written through an outbox and retried if the destination is
    unreachable.
  - Entries are kept for the backup retention period plus 30 days (`deletion_ledger.prune`), which is
    long enough for every backup that could contain the user to have expired.
  - Restoring a backup replays the ledger and erases any listed user present in the restored data
    before the stack accepts traffic (§8.7).

### 4.13 Admin: users

- **Search and filter** users (full-text on username and email; filters on state, age band, role,
  created date).
- **User detail** is assembled over the bus: profile, sign-in methods (never secrets), sessions,
  security events, username history, guardians, moderation history (if Safety is enabled),
  entitlements (if Games is enabled), tickets (if Support is enabled).
- **Actions:** ban, unban, lock (with expiry), unlock, force re-auth, revoke sessions,
  **force username reset** (user picks a new one on next sign-in), edit DOB. Each needs a reason and
  is audited.
- **Retention sweep** manual trigger.

### 4.14 Roles and permissions (RBAC)

- **Fine-grained permission strings,** e.g. `users.read`, `users.ban`, `users.lock`, `users.edit_dob`,
  `safety.reports.read`, `safety.actions.apply`, `safety.csea.access`, `support.tickets.staff`,
  `support.kb.edit`, `games.catalog.edit`, `games.entitlements.grant`, `games.keys.manage`,
  `oidc.clients.suspend`, `oidc.clients.verify`, `webhooks.manage`, `audit.read`, `roles.manage`.
- **Roles** are defined in config (built-ins: `admin`, `moderator`, `support_agent`, `kb_editor`,
  `game_manager`) and editable in the UI with `roles.manage`.
- Each service declares its permissions in its route manifest, so a disabled service's permissions
  don't exist.
- **`safety.csea.access` is never matched by a wildcard** and must be granted explicitly.
- **Bootstrap:** `docker compose run --rm identity qtiauth admin create --email …` issues a one-time
  signup link for the first admin. There are no default credentials.

### 4.15 Audit log

- Records every staff action, security-sensitive user action (password, 2FA, email or deletion
  changes) and administrative configuration change (roles, webhooks, OAuth client verification).
- Services publish `audit.recorded`, and identity stores it. Filterable by actor, action, target and
  date.
- **Append-only:** the audit DB role has `INSERT` and `SELECT` only. Each row includes the hash of the
  previous row, so tampering is detectable. `qtiauth audit verify` checks the chain.

### 4.16 Notification preferences

- Per-user, per-category toggles. Categories are declared by each service (e.g.
  `support.ticket_updates`).
- **Security and legal notifications can't be disabled per user.** The new-device email is the one
  that can be turned off, and only app-wide (§4.8).
- **Staff alert preferences:** new tickets, high-priority reports.

---

## 5. Notifier service (core)

### 5.1 Email

- **Providers:** `smtp`, `brevo`, `postmark`, `ses`, `resend`, `mailgun`, `console` (logs to stdout
  for development). One interface: `send(message) → { provider_message_id }`.
- **Templates:** MJML + plain text per locale in `config/templates/email/`. Defaults ship in the image,
  and any file of the same name in config overrides the default. Template variables are strictly
  typed, and a missing variable fails at startup, not at send time.
  - Each template is `<locale>/<template>.subject.txt`, `<template>.txt` and `<template>.mjml`, with
    `{{ variable }}` placeholders. Every template can also use `brand.product_name`,
    `brand.company_name`, `brand.support_email` and `brand.primary_color` from `branding`.
  - Templates and their variables are declared in `packages/email`. The notifier refuses to start if
    a template uses a variable it isn't given, has invalid MJML, or is missing from
    `email.default_locale`. `qtiauth templates check` runs the same checks.
  - An email uses its locale, then its language alone, then `email.default_locale`.
- **Sender identities** per category: auth, security, support.
- **Delivery log:** status, provider ID, retries. Bounce and complaint webhooks where the provider
  supports them, with automatic suppression of hard-bouncing addresses.
- **Outbound queue:** a JetStream work queue with retries, so a provider outage delays mail instead of
  failing the user's request. Sign-in, reset and verification emails are high priority.
  - Services call `queueEmail` from `packages/email`, which checks the variables before publishing to
    `qtiauth.work.notifier.email.high` or `.normal`, by the template's priority. Each queue has its
    own consumer, so normal mail never holds up high-priority mail.
  - A failed send is retried from `email.queue.retry_delay`, doubling up to `max_retry_delay`, for
    `max_attempts` attempts (about 6 hours by default), then marked `failed`. Delivery is at least
    once, and an email the delivery log records as `sent` is never sent again.

### 5.2 Webhooks

A general platform feature. Report events are the first use.

- **Endpoints** are managed in the admin UI and can be seeded from config. Each has a URL,
  description, **event subscriptions** (wildcards like `safety.report.*`), format and secret.
- **Formats:**
  - `standard`: the JSON envelope, signed per [Standard Webhooks](https://www.standardwebhooks.com/)
    (`webhook-id`, `webhook-timestamp`, `webhook-signature` = HMAC-SHA256).
  - `discord`: Discord webhook message (embeds). Paste a Discord channel webhook URL and it works.
  - `slack`: Slack incoming-webhook message (Block Kit).
- **Delivery:** at-least-once, exponential backoff for up to 24 h, then marked failed. An endpoint is
  **auto-disabled** after `webhooks.disable_after_failures` (default 50) consecutive failures, and
  admins are emailed.
- **Delivery log** with request and response (bodies truncated), manual **replay**, **test event**
  button, and **secret rotation** with an overlap window where both secrets are valid.
- **SSRF protection:** URLs resolving to private, loopback or link-local addresses are rejected unless
  `webhooks.allow_private_targets: true`.
- **Payload minimisation:** payloads carry IDs, types, priority, timestamps and an admin deep link,
  **never content**. Report webhooks never include content snapshots, descriptions or reporter
  identity. **CSEA events never go to webhooks** (§6.2).

**Initial webhook events:** `safety.report.created`, `safety.report.actioned`,
`safety.report.dismissed`, `safety.report.sla_breached`, `safety.appeal.created`,
`identity.user.created`, `identity.user.banned`, `identity.user.deleted`, `support.ticket.created`,
`support.ticket.status_changed`, `games.entitlement.granted`, `games.entitlement.revoked`,
`oidc.client.created`.

---

## 6. Optional services

### 6.1 OIDC provider (`oidc` profile)

One service with two sub-features: **provider** and **developer portal**. They share the client
registry.

#### Protocol

- **Discovery** at `/.well-known/openid-configuration`, **JWKS** at `/.well-known/jwks.json`.
- **Endpoints:** `authorize`, `token`, `userinfo`, `revoke` (RFC 7009), `introspect` (RFC 7662).
- **Grants:**
  - `authorization_code`, with **PKCE S256 mandatory**.
  - `refresh_token`, with rotation. **Reuse detection:** presenting an already-rotated refresh token
    revokes the whole token family.
  - `client_credentials` for game servers and backend systems.
  - **Device Authorization Grant** (RFC 8628) for consoles, game clients, CLIs and TVs.
- **Access tokens are JWTs** (RFC 9068) with `aud`, so game servers can verify them locally via
  JWKS. `introspect` is available for immediate revocation checks.
- **ID tokens** RS256 or ES256, with `at_hash`.
- **Pushed Authorization Requests** (RFC 9126), optional per client.
- **Back-channel logout** (OpenID Connect Back-Channel Logout 1.0):
  - Clients register a `backchannel_logout_uri` (and optionally `backchannel_logout_session_required`).
  - When a session ends (logout on any surface, revocation, lock, ban or deletion), the provider POSTs
    a signed logout token (`iss`, `aud`, `sub`, `sid`, `events`, `jti`) to every client that received
    tokens during that session.
  - Delivery is queued with retries, and results are visible in the client's delivery log.
  - Refresh tokens tied to the ended session are revoked. `offline_access` tokens are not, unless the
    account was locked, banned or deleted.
  - Advertised in discovery (`backchannel_logout_supported`, `backchannel_logout_session_supported`).

#### Keys

Keys are **generated by each service** and stored envelope-encrypted with `KEY_ENCRYPTION_KEY` from
`.env`. They **rotate automatically** (`keys.rotate_every`, default 90 days), and the previous key
stays published until every token it signed has expired.

**Separate keys per purpose:**

| Purpose | Owner | Published at |
|---|---|---|
| OIDC ID and access tokens, logout tokens | `oidc` | `/.well-known/jwks.json` |
| Game licence leases and revocation lists | `games` | `/.well-known/qtiauth-license-keys.json` |
| Internal identity tokens | `gateway` | internal only |

A compromise of one key can't forge tokens for another purpose.

#### Scopes and claims

- **Scopes are defined in config**, each with its consent-screen text and the claims it releases.
- **Built-in:**
  - `openid`
  - `profile`: `preferred_username`, `username_updated_at`
  - `email`: `email`, `email_verified`
  - `offline_access`
  - `age`: `age_band` and `age_assurance_strength`. **Never date of birth.**
  - `parental_controls`: the guardian control object for child accounts (§4.7)
  - `restrictions`: active moderation restrictions (§6.2)
  - `games`, `achievements`, `game_stats`: read access, served by the games service over the bus
  - `achievements.write`, `game_stats.write`: trust-based writes, only grantable to a game's own client (§7.4, §7.5)

#### Consent

- Consent is stored per user per client. Users are re-prompted only when new scopes are requested.
- **First-party clients** declared in config skip consent.
- **Child accounts:** consent for non-first-party clients goes to a guardian (§4.7).
- Users can see and revoke authorized apps.

#### Developer portal

- Create, list, edit and delete clients. Regenerating a secret requires step-up.
- Confidential and public client types.
- **Redirect URIs are exact-match only.** Native apps may use loopback URIs on any port (RFC 8252).
- **No admin approval gate.** Clients work as soon as they're created. Instead:
  - Clients that are neither first-party nor admin-verified show an **"Unverified app"** notice on the
    consent screen. Verification (`oidc.clients.verify`) is a badge, not a gate.
  - Client names and descriptions go through the text filter (§4.11). Names containing
    `branding.product_name` are rejected unless the client is verified.
  - Staff with `oidc.clients.suspend` can suspend a client, which revokes all its tokens and blocks new
    authorizations.
  - `oidc.developer_portal.max_clients_per_user` (default 10).
  - Child accounts can't create clients.

### 6.2 Safety (`safety` profile)

#### Reporting

- Report a user, report content, check report status.
- **Taxonomy in config:** types, subtypes, default priority, **SLA per type**, and whether the type is
  CSEA-flagged. The default taxonomy is 9 types × 15 subtypes mapped to Online Safety Act harm
  categories, with a 24 h default SLA and 1 h for CSEA and terrorism.
- **Content snapshot** at report time.
- **Report intake API for games:** games with chat or user-generated content (the parts of an
  ecosystem that are user-to-user services under the OSA) submit reports with `auth: service` or
  `auth: oauth`. The payload has game ID, reported user ID, content snapshot and context.
- **Automated flag intake:** games and other services submit machine-generated flags (score,
  classifier name), which enter the moderation queue.
- Reporters get an acknowledgement and an outcome notification. Reporters are never identified to the
  reported user.
- **SLA breaches** emit `safety.report.sla_breached`, which is available to webhooks.

#### Moderation

- Queue, report detail, apply action, dismiss. History per user and per moderator.
- **Action types are defined in config with real effects:**

  | Action | Effect |
  |---|---|
  | `warn` | Notifies the user with a statement of reasons. No restriction. |
  | `restrict` | Adds named restrictions (e.g. `chat`, `ugc`, `username_change`), exposed to games via the internal token and `restrictions` claim. Optional expiry. |
  | `force_username_reset` | User must choose a new username. |
  | `lock` | Temporary. The account can only reach appeals, support and data rights. Auto-expires. |
  | `ban` | Permanent until lifted. Same access as `lock`. |
  | `remove_content` | Emits `safety.content.removal_requested` for the originating game or service. |
  | `proscribed_org_removal` | Ban with the reason code for ICU H1. |

- **Statement of reasons:** every enforcement action sends the user an explanation of the rule, the
  action, its duration and how to appeal. Staff must choose a rule from the configured list to apply
  an action.
- **Appeals:** locked, banned or restricted users can appeal. With Support enabled, the appeal is a
  ticket (§6.3). Without it, Safety provides a minimal appeal form. Staff resolve an appeal by lifting
  the action or leaving it in place, and the user is notified.
- **Two-person rule** for permanent bans (optional, `safety.bans.require_second_approval`).
- **Metrics** from events: reports received, actioned and dismissed, time-to-action per type, SLA
  breaches, appeals and appeal outcomes (§8.6).
- **Accountable person:** `safety.accountable_person` (name and role) is shown in the admin UI and
  available to legal document templates (ICU A2).

#### CSEA / NCA reporting workflow

This is a legal duty for **every** regulated user-to-user service since 7 April 2026, regardless of size.

- A report with a CSEA-flagged type, or one reclassified by a moderator, opens a **CSEA case**.
- **Restricted access:** only holders of `safety.csea.access` can see the case, snapshot or evidence.
  Every view is audited.
- **Evidence preservation:** the content snapshot and relevant metadata (account identifiers, IPs,
  timestamps) are copied into an isolated, encrypted evidence store under a **legal hold** that
  survives account deletion.
- **Guided NCA submission:** the case page lists the fields the NCA Industry Reporting Portal
  (CSEA-IRP) requires. The moderator submits through the portal and records the NCA reference and
  submission time. The case tracks deadlines. If the NCA provides an API later, submission becomes a
  provider plugin.
- **Immediate protective action:** one-click lock plus content removal request from the case page.
- **Never** sent to webhooks, email bodies, logs or analytics. The only notification is an alert to
  `safety.csea_alert_emails` that a case exists, with a link.
- Evidence is kept for the retention period set in config (default: the statutory minimum), then
  destroyed with an audit record.

> Before implementing, confirm the exact report fields, timeframes and retention periods against
> The Online Safety (CSEA Content Reporting by Regulated User-to-User Service Providers) Regulations
> 2026 (SI 2026/268). This spec defines the workflow, not the legal parameters.

### 6.3 Support (`support` profile)

#### Tickets

- Create, list, view, reply, close, reopen, rate (1–5).
- **Sequential ticket numbers** from a Postgres sequence.
- Priority, status, assignment, **internal notes**.
- **Categories in config**, each optionally marked guest-allowed.
- **Appeals from restricted accounts:** banned and locked users can open tickets through route policy
  (`allow_account_states: [banned, locked]`). The category is forced to the appeal type, limited to
  one open appeal per enforcement action, and linked to the Safety action when Safety is enabled.
- **Emails:** new ticket → staff (per staff preference), staff reply → user, status change → user.
- **Guest tickets:** for people who can't sign in. A guest enters an email, verifies it with a code,
  and follows the ticket through a magic link. Rate-limited and CAPTCHA-protected.
- **Attachments** (needs storage): images, PDF and text, with size and type limits in config.
  Content-type sniffing. Served only via short-lived signed URLs with
  `Content-Disposition: attachment`. Staff see a warning on non-image files.
- **Canned responses / macros** for staff.
- **Auto-close** tickets waiting on the user after `support.auto_close_after` (default 7 days), with a
  reminder at the halfway point.
- **Staff metrics:** first response time, resolution time, CSAT, per agent and per category.
- **Reply by email** `LATER`

#### Knowledge base

- Public list, search, article and category views.
- Staff create, edit and delete. Drafts and published states, tags, Markdown, slugs.
- Categories with icon and display order.
- **Search:** Postgres full-text, weighted title > tags > body.
- **Revision history** with diff and restore.
- **Images** uploaded to storage (optional).
- **"Was this helpful?"** is rate-limited per IP and deduplicated per session.
- **Related articles** are suggested while a user types a ticket subject.
- Markdown is rendered server-side with a strict sanitizer. No raw HTML.

---

## 7. Games service (`games` profile)

### 7.0 Trust model

Game data comes in at one of two trust levels:

| Trust level | Written with | Used for |
|---|---|---|
| **Player** | The player's own access token for that game | Achievements, progress, `authority: player` stats, `custom_data`, playtime |
| **Game** | Game server credential + player token (`auth: game_authoritative`, §7.5) | `authority: game` stats and the leaderboards built on them |

Player-trust data is trust-based on purpose. It gives no reward, so faking it only fools the player,
the same as on Steam or Epic.

**Hard rule: nothing that grants value may be triggered by player-trust data.** That covers
entitlements, keys, DLC, cosmetics, prizes and anything else with value. It also covers public
recognition beyond the player's own profile.

- Every game event carries `trust: player | game` in its envelope `data`, and webhook payloads include
  it, so external integrations can see what they're reacting to.
- No built-in automation grants entitlements or keys from player-trust events.
- Reward features added later must consume game-trust data only. Anything achievement-based must
  first move that achievement to game authority.

### 7.1 Catalog

- **Games** have name, slug, description, icons and art, and a status: `draft`, `hidden`,
  `early_access`, `released`, `archived`. Draft and hidden games are visible only to staff.
- **Full create, read, update and delete** for games, products, achievements, stats and leaderboards.
- **Per-game settings:** lease duration, stat definitions, leaderboards, cloud-save quota, Steam app.
- **Game server credential:** each game automatically gets one confidential server client (the game's
  server key), scoped to that game only, with a rotatable secret. It's used for `auth: service` and
  `auth: game_authoritative` calls (§7.5).

### 7.2 Products and entitlements

- **Products** belong to a game: `base`, `dlc`, `edition`, `beta_access`, `soundtrack`, etc. The base
  product is created with the game.
- **Entitlements** link user and product, with a **source** (`admin_grant`, `key_redemption`, `steam`,
  `api`), granted-by, granted-at, optional expiry (e.g. timed betas), revoked-at and revoke reason.
- **Admin grant and revoke** in the UI.
- **External grant API** (`auth: service`, scope `games.entitlements.write`) for external payment
  systems, storefronts or Patreon integrations.
- `GET /api/v1/games/owned`, `GET /api/v1/games/:slug/owned` (product-aware).

### 7.3 Key redemption

- Generate key batches per product: count, format, optional expiry, batch label (e.g. "press",
  "kickstarter").
- Users redeem on the account site, or in-game through the API.
- Per-user and per-IP redemption limits. Failed attempts are tracked to detect brute-forcing, and
  CAPTCHA kicks in after failures.
- **Batch export** as CSV (step-up required). **Batch revoke**, optionally also revoking entitlements
  granted from the batch.

### 7.4 Achievements

- Definitions with points and icons. Per-user unlocks. Completion percentage.
- **Hidden achievements:** name and description stay hidden until unlocked.
- **Progress achievements:** a `progress_target` (e.g. 0/100) with progress updates from the game.
  They unlock automatically at the target.
- **Rarity:** the share of owners who have unlocked each achievement, recomputed nightly.
- **Admin revoke** of an unlock (e.g. for cheating), with a reason, audited.

**Trust-based writes.** Unlocks and progress updates use `auth: oauth` with the **player's own
access token**, which must be issued to **that game's** client and carry the `achievements.write`
scope. Another app the player has authorized can't unlock achievements in a game it doesn't belong to.

Achievements give no reward, so they're trust-based by design, the same as on Steam or Epic, where a
determined player can fake them too. Games with their own server can still send unlocks with the
game-authoritative pattern (§7.5) if they want to. Cheated unlocks are handled by admin revocation.

### 7.5 Stats and leaderboards

- **Stat definitions** per game: key, type (`int`, `float`, `duration`), aggregation (`sum`, `max`,
  `min`, `latest`), optional **max delta per update** as a sanity bound, and `authority`:
  - `player` (default): written with the player's own access token (issued to that game's client,
    scope `game_stats.write`). Trust-based, like achievements.
  - `game`: written only through `auth: game_authoritative` (below).
  - Free-form `custom_data` JSON per user per game remains available with the player's token.
- **Leaderboards:** defined on a stat, with sort direction and a reset period (`never`, `daily`,
  `weekly`, `monthly`, `season:<id>`). History is kept for past periods.
  - **Server authority is toggleable:** `features.games.leaderboards.require_game_authority`
    (default `true`), overridable per game. When it's on, a leaderboard can only be defined on a stat
    with `authority: game`. When it's off, trust-based player stats can feed leaderboards too.
  - **Visibility:** users can hide themselves. **Accounts under 18 are hidden by default**, and a
    guardian or the teen can opt in (§4.6). Hidden entries still count in ranking but show as
    "Hidden player".
  - Admins can remove entries (e.g. cheating) with a reason, audited.
- **Playtime:** games send session start, heartbeat and end with the player's access token
  (trust-based). The service accrues playtime per game, which feeds the guardian activity summary.
  Games query remaining time to enforce `daily_playtime_minutes`.

**Game-authoritative writes** (`auth: game_authoritative`) require **both** of these on the same
request:

1. **The game server's credential:** a `client_credentials` access token for that game's server client
   (§7.1), in `Authorization: Bearer`.
2. **The player's access token:** an access token issued to **that game's** client for the player, in
   `X-QTIAuth-Player-Token`.

The gateway checks that both tokens belong to the same game and that the player token is valid and
unexpired, then acts on the player token's `sub`. A player can't submit scores with only their own
token, and a game server can't submit scores for a player who isn't signed in to that game.

A game without its own server can't write `authority: game` stats, because a server key shipped
inside a game client could be extracted. Such games either use trust-based leaderboards
(`require_game_authority: false`) or none.

> **What game authority does and doesn't protect against.** The server credential proves a score
> came **through the game's server**. That stops anyone scripting fake submissions straight at the
> API. It does **not** prove the score is legitimate. If the game server just relays whatever score
> the client reports, memory editing and modified clients still work. Leaderboards are only as
> trustworthy as the game server's own validation (server-side simulation, replay checks, sanity
> bounds). That's the game's responsibility. The developer docs must say this clearly.

### 7.6 Cloud saves (needs storage)

- Slots per user per game. Metadata in Postgres, blobs in object storage via presigned URLs.
- Version history (last N per slot), with conflict detection via a `base_version` precondition. The
  client resolves conflicts.
- Per-game quota (slots × size).
- Included in data exports and erased on account deletion.

### 7.7 Licensing (offline leases)

- **Issue a signed lease** proving ownership, for offline play.
- **Lease duration per game** in config (default 20 days).
- **Leases list every owned product** for the game (base and DLC).
- Each lease has a **`jti`**, and revocation is by `jti`.
- **Offline verification:** leases are signed with the dedicated licensing key, published at
  `/.well-known/qtiauth-license-keys.json`, so game clients can verify with no network.
- **Unauthenticated verify endpoint** for game servers that prefer online checks.
- **Signed revocation list:** `GET /api/v1/games/licensing/revocations?since=…` lets
  occasionally-online servers pull revocations in bulk.
- **Device binding** (optional per game): the lease carries a hash of a client-generated device ID.
  `licensing.max_devices` limits concurrent devices, and users manage their devices on the account
  site.
- **Admin revoke** of leases per user and game.

### 7.8 Steam

**Config**

```yaml
features:
  games:
    steam:
      enabled: true
      publisher_key: "${env:STEAM_PUBLISHER_KEY}"   # required; startup fails without it
      web_api_host: partner.steam-api.com
      unlink_cooldown: 7d
      apps:
        - app_id: 1234560
          game_slug: my-game
          ticket_identity: "qtiauth"      # must match the identity passed to GetAuthTicketForWebApi
          family_sharing: allow           # allow | deny | allow_no_entitlement
          sync_ownership: true
```

**Account linking and sign-in**

- Users link Steam on the account site through Steam OpenID 2.0 (§4.4), which stores the verified
  SteamID64 as an identity. One Steam account links to one QTIAuth account.
- Linked Steam accounts can also be used to sign in when `features.auth.social.steam` is enabled.
- **Unlinking has a cooldown** (`unlink_cooldown`) to stop link-hopping.

**In-game ticket authentication**

`POST /api/v1/games/steam/authenticate`, using `auth: service` (the game server credential) or
`auth: none` with per-app rate limiting.

- **Body:** `{ app_id, ticket, issue_tokens? }`, where `ticket` is the hex ticket from
  `ISteamUser::GetAuthTicketForWebApi(identity)`.
- **Steam check:** calls `ISteamUserAuth/AuthenticateUserTicket/v1` on the partner host with the
  publisher key and the app's `ticket_identity`, and requires `result == "OK"`.
- **Family sharing:** the app's `family_sharing` policy is applied by comparing `ownersteamid` with
  `steamid`.
- **Bans:** `vacbanned` and `publisherbanned` are recorded.
- **Response:**
  ```json
  {
    "valid": true,
    "steam_id": "7656119…",
    "owner_steam_id": "7656119…",
    "family_shared": false,
    "vac_banned": false,
    "publisher_banned": false,
    "user_id": "01J…",          // null if the Steam account isn't linked
    "entitled": true,
    "device_code": null         // if not linked: a device-flow code so the player can link now
  }
  ```
- **Browserless sign-in:** if the Steam account is linked and `issue_tokens: true` is sent (and the
  game's client allows it), the response also includes an OIDC token set for that player and game.
  A Steam game can sign players in without a browser this way.

**Ownership sync**

- On link, and nightly for linked users, call `ISteamUser/CheckAppOwnership/v4` for every app with
  `sync_ownership: true`, then grant or revoke the base product entitlement with source `steam`.
- The sync never revokes a product that another source also grants.

**Rules**

- No keys in source, no fallback test keys, no default app IDs.
- Steam Web API failures return `502` with a stable error code. Tickets are never logged.

---

## 8. Cross-cutting concerns

### 8.1 Rate limiting

- Enforced by the gateway on **every** route, including every auth route.
- Named policies in config, referenced by route manifests:
  ```yaml
  rate_limits:
    global:            { per: ip, limit: 300, window: 1m }
    auth_password:     { per: [ip, account], limit: 10, window: 15m }
    magic_link_email:  { per: email, limit: 3, window: 1h }
    magic_link_ip:     { per: ip, limit: 10, window: 1h }
    magic_link_ip_day: { per: ip, limit: 20, window: 1d }
    auth_verify:       { per: ip, limit: 30, window: 15m }
    ticket_create:     { per: user, limit: 5, window: 1h }
    guest_ticket:      { per: ip, limit: 3, window: 1h }
    key_redeem:        { per: [ip, user], limit: 10, window: 1h }
    kb_feedback:       { per: ip, limit: 30, window: 1h }
  ```
- Sliding window in Valkey. Responses are `429` with `Retry-After` and `RateLimit-*` headers.
- **Fail-open or fail-closed per policy** when Valkey is unreachable. Auth policies default to closed.
- `global` applies to every request as well as the route's own policy, including unknown paths and
  CORS preflights.
- `per` is `ip`, `user` (the IP for anonymous callers), `client` (the IP without an OAuth client),
  `email` (the JSON body's `email`) or `account` (the body's `identifier`, `email` or `username`).
  A list counts each combination of values separately.
- A policy can instead group others, `{ policies: [a, b] }`, which applies all of them, for routes
  such as magic-link start that need several limits.
- Policies in config replace built-in policies of the same name. The rest stay available.

### 8.2 Bot protection

- Pluggable CAPTCHA: `altcha` (**default**, self-hosted proof-of-work, no third-party calls),
  `turnstile`, `hcaptcha`, `friendly_captcha`, `none`.
- **Adaptive:** shown only after rate or failure thresholds are hit on signup, password login,
  magic-link start, guest tickets and key redemption.

### 8.3 API conventions

- Versioned under `/api/v1/…`. OIDC endpoints and `/.well-known/*` stay at their standard paths.
- **OpenAPI 3.1** generated per service from route definitions. The gateway serves the merged document
  for enabled services at `/api/v1/openapi.json`.
- **Errors:** RFC 9457 Problem Details (`application/problem+json`) with a stable machine-readable
  `code` (`ACCOUNT_BANNED`, `LEGAL_ACCEPTANCE_REQUIRED`, `STEP_UP_REQUIRED`, …), `type`
  `urn:qtiauth:problem:<code>` and the `request_id`. User-facing text is the frontend's job. Each
  service registers its codes, and the OpenAPI document lists the codes every operation can return.
- Cursor pagination on every list that can grow: `?limit=&cursor=`, answered with
  `{ items, next_cursor }`, where `next_cursor` is opaque and `null` on the last page.
- API timestamps are RFC 3339 UTC strings.

### 8.4 Retention

All periods are configurable.

| Data | Default |
|---|---|
| Expired or revoked sessions and bindings | 30 days |
| Session security events | 90 days |
| OAuth `state` / PKCE temp, binding codes | 10 minutes (Valkey TTL) |
| Magic-link, reset and verification tokens | 24 hours after expiry |
| Rate-limit counters | window length (Valkey TTL) |
| Text-filter decision logs (raw input) | 30 days |
| Email, webhook and back-channel logout delivery logs | 30 days |
| Audit log | 2 years |
| Closed tickets | 2 years after closing |
| Resolved reports (non-CSEA) | 1 year after resolution |
| CSEA evidence | statutory minimum (SI 2026/268) |
| Accounts pending parental consent | 14 days |
| Accounts pending deletion | 30 days |
| Deletion ledger entries | backup retention + 30 days |

### 8.5 Internationalisation

- The backend returns error codes, not prose. Emails are templated per locale.
- Users have a `locale` preference, defaulting from `Accept-Language`.
- The frontend is built with i18n from day one, even if only `en-GB` ships at first.

### 8.6 Observability

Metrics are a first-class deliverable, not an afterthought.

**Logs and traces**

- Structured JSON logs with `trace_id`, `request_id`, hashed `user_id`, service and level. User IDs
  are hashed with a keyed hash shared by every service, so one user's logs can still be joined.
- **Never logged:** tokens, passwords, TOTP codes, recovery codes, Steam tickets, report content,
  email bodies, raw text-filter input (outside `filter_decisions`).
- OpenTelemetry traces across gateway → service → NATS → consumer, with trace context carried in the
  event envelope (`trace_id` and `span_id`) and in NATS message headers (`traceparent`). Trace IDs
  are created and propagated even when no trace collector is configured, so logs can always be
  correlated.

**Metrics**

- Every service exposes Prometheus `/metrics` on the internal network, and can optionally push OTLP
  metrics.
- **Cardinality rule:** no user IDs, emails, IPs or other unbounded values in labels. The metrics
  registry refuses to create a metric with such a label.
- **Catalogue (minimum):**

  | Area | Metrics |
  |---|---|
  | HTTP (gateway) | requests by surface, route, method, status; latency histograms; upstream errors per service; request/response sizes |
  | Auth | sign-ins by method and result; signups by method and age band; magic links sent / used / expired; password failures; breach-check rejections; 2FA challenges by factor and result; passkey registrations; step-up prompts; CAPTCHA shown / solved / failed |
  | Sessions | active sessions; sessions created / revoked by reason; bindings created; trust-level transitions; country-change challenges and blocks; new-device emails |
  | Accounts | accounts by state; pending parental consent; guardian approvals / declines / expiries; deletions requested / cancelled / completed; data exports; legal re-acceptance pending |
  | Text filter | decisions by rule; unknowns logged |
  | Rate limiting | hits and rejections per policy; Valkey fail-open events |
  | Bus | publish / consume rate per subject; consumer lag; redeliveries; outbox backlog size and oldest-row age; RPC latency and no-responder counts |
  | Notifier | emails by provider, template and status; send latency; bounces and suppressions; webhook deliveries by endpoint format and status; delivery latency; auto-disabled endpoints |
  | OIDC | authorizations by client type and result; token grants by grant type; refresh-token reuse detections; introspections; device-flow approvals; back-channel logout deliveries and failures; key age |
  | Safety | reports by type and source; queue depth by priority; time-to-first-action histogram; SLA breaches; actions by type; appeals opened and resolved; CSEA cases open (count only) |
  | Support | open tickets by status and category; first-response and resolution time histograms; CSAT distribution; guest tickets; auto-closes; KB views and feedback |
  | Games | entitlements granted and revoked by source; key redemptions and failures; achievement unlocks and progress updates; game-authoritative auth rejections by reason; leaderboard writes; playtime heartbeats; cloud-save bytes and conflicts; leases issued and verified; revocation-list pulls; Steam API latency and errors by method |
  | Infra | DB pool usage and query latency per service; migration runs; Valkey latency; NATS connection state; scheduler job runs, duration and failures; backup runs, size, duration and failures |

- **Health:** `/healthz` (liveness) and `/readyz` (DB, NATS, Valkey) per service. The admin UI shows an
  aggregate status page with config warnings (no GeoIP, no storage, staff without 2FA, cross-site
  surface pairs, and so on).

**`observability` profile (v1)**

- Prometheus, Grafana, Tempo and Loki, pre-wired.
- **Prebuilt Grafana dashboards:** stack overview, gateway, auth and sessions, bus, notifier, each
  optional service, and infra.
- **Default alert rules:** error-rate spikes, auth failure spikes, outbox backlog age, consumer lag,
  webhook auto-disables, SLA breaches, backup failures, key rotation overdue, certificate expiry
  (with `edge`).

### 8.7 Backups

- **`backup` profile:** scheduled `pg_dump` of every schema, plus a manifest of object-storage keys
  (bucket replication is the storage provider's job), written to object storage or a mounted volume,
  with retention in config (`backups.retention`, default 35 days).
- **Encrypted:** backups are encrypted with `BACKUP_ENCRYPTION_KEY`. **They can't be read without
  restoring onto the stack.**
- **Restore only through the CLI:** `qtiauth backup restore <id>`:
  1. Puts the stack into maintenance mode, where the gateway serves `503` to everything except health.
  2. Decrypts and restores.
  3. **Replays the deletion ledger** (§4.12) and re-erases every listed user found in the restored
     data, including their stored objects.
  4. **Revokes all restored sessions and bindings**, because they may have been revoked after the
     backup was taken.
  5. Runs migrations for the running service versions.
  6. Leaves maintenance mode.
- `qtiauth backup verify <id>` restores into a scratch database and checks integrity, without touching
  the live stack.

### 8.8 CLI

`qtiauth` is available in every service image:

`config check` · `db provision` · `migrate status|up` · `routes manifest` · `routes openapi` ·
`admin create` · `lists update` · `lists audit` · `keys rotate` · `audit verify` · `backup restore` ·
`backup verify` · `user export <id>` · `user delete <id>`

### 8.9 Security baseline

- **Headers:** strict nonce-based CSP for the web app, HSTS, `X-Content-Type-Options`,
  `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`, and
  `frame-ancestors 'none'` everywhere (the consent screen can never be framed).
- Secrets are compared in constant time. Tokens are 256-bit CSPRNG values stored hashed.
- Dependency and container image scanning in CI. Images run as non-root with a read-only root FS.
- Only `gateway` (or `caddy` with the `edge` profile) publishes ports. Everything else stays on the
  internal Docker network.
- `SECURITY.md` with a vulnerability disclosure process.

---

## 9. Online Safety Act mapping

*Not legal advice. This maps the design to the duties identified in research. Deployments must run
their own risk assessments using Ofcom's Regulation Checker and Child Access Assessment tools.*

**Scope.** The account site, support and KB are **not** user-to-user services. **Games with chat, UGC
or player interaction are.** The duties below apply to those games, and QTIAuth provides the
machinery. Highly effective age assurance is **not** mandatory as long as terms prohibit primary
priority and priority content and moderation can remove it (PCU B2–B7). The Category 1 user identity
verification duty does **not** apply below 7m UK users.

| Duty / measure | Applies to | Where |
|---|---|---|
| Illegal content risk assessment, reviewed annually | All U2U services | Process. Compliance register `LATER` |
| Children's access and risk assessment | U2U services likely accessed by children | Process. Age band data (§4.6) supports it |
| **ICU A2** named accountable individual | All | `safety.accountable_person` (§6.2) |
| **ICU C1/C2** moderation function, swift takedown | All | §6.2 moderation, `remove_content`, game intake API |
| **ICU D1/D2** easy reporting and complaints | All | §6.2 reporting, game intake API |
| **ICU D7** act on complaints about illegal content | All | §6.2 queue and SLAs |
| **ICU D9/D10** appeals | Services that aren't large or multi-risk | §6.2 appeals, §6.3 appeal tickets |
| **ICU G1/G3** clear, accessible terms | All | §4.9 |
| **ICU H1** remove proscribed organisation accounts | All | §6.2 `proscribed_org_removal` |
| **ICU F1/F2** child safety defaults | High grooming risk, with existing age knowledge | Not triggered by QTIAuth (no social features, §1.2). `age_band`, `restrictions` and `parental_controls` let games implement them |
| **PCU B2–B7** highly effective age assurance | Only if priority content is permitted or can't be removed | Not triggered by default. Pluggable provider ready (§4.6) |
| **s.66 CSEA reporting to the NCA** (since 7 April 2026) | **All U2U services, any size** | §6.2 CSEA workflow |
| Record-keeping of risk assessments and measures | All | Compliance register `LATER` |

**Related law outside the OSA:** ICO Age Appropriate Design Code and UK GDPR → §4.6 under-18
defaults, §4.7 parental consent, §4.12 data rights and deletion ledger, §8.4 retention, §8.7 encrypted
backups.

---

## 10. Dropped from the old system

| Item | Replacement / reason |
|---|---|
| `worker.js` monolith | Dead code |
| Minecraft / JagSMP integration (endpoints, 7 tables, plugin secret) | Removed |
| Legacy token grandfathering | Deadline long past |
| HS256 JWT session tokens | Opaque sessions (§2.7) |
| OAuth access tokens accepted on first-party routes | Strict credential separation (§2.7) |
| `POST /auth/session` bearer-to-cookie conversion | Session bindings (§2.10) |
| `SameSite=None` cross-subdomain cookie | Per-host bindings, same-origin core API (§2.10) |
| Admin approval gate for OAuth clients | Unverified-app notice and suspension (§6.1) |
| Substring-matching `banned_words` engine | Text filter (§4.11) |
| Stored `is_child` flag and claim | Computed `age_band` (§4.6) |
| Unused `parental_consent` column | Parental consent flow (§4.7) |
| `daily_stats` table | Metrics (§8.6) |
| Single PEM keypair for ID tokens and leases | Per-purpose rotating keys (§6.1) |
| Hardcoded CORS list, Steam test key and app IDs, branding fallbacks | Config (§3) |
| Fixed `user` / `support` / `admin` roles | RBAC (§4.14) |
| Lease revocation by `iat`/`exp` equality | `jti` (§7.7) |
| Brevo-only email | Provider abstraction (§5.1) |
| `schema.sql` / `migrations/` references | Per-service migrations (§2.3) |

---

## 11. Decisions

| # | Decision |
|---|---|
| 1 | **TypeScript 6.0 on Node 26**, run directly with Node type stripping (no build step). Hono for HTTP, `pnpm` workspace monorepo with shared packages (`@qtiauth/config`, `@qtiauth/bus`, `@qtiauth/auth-context`, `@qtiauth/text-filter`), Kysely for SQL, Zod for config and payload validation. |
| 2 | Services per §2.2. Auth methods and smaller features are config flags, not containers. |
| 3 | Passkeys, TOTP and recovery codes in v1. |
| 4 | Every guardian control and notification in §4.7 in v1. |
| 5 | Country-change default is `challenge`. |
| 6 | Every games feature in §7 in v1. |
| 7 | Every support feature in §6.3 in v1, except reply-by-email (`LATER`). |
| 8 | Default CAPTCHA is `altcha`. |
| 9 | Default GeoIP source is DB-IP Lite. |
| 10 | Social features are a permanent non-goal. |
| 11 | Discord and Slack webhook formats in v1. |
| 12 | Project name is **QTIAuth**. CLI `qtiauth`, config `qtiauth.yaml`, packages `@qtiauth/*`, bus subjects `qtiauth.*`. |
