# Config reference

Every setting in `config/qtiauth.yaml`, with its type, default and one-line description. Generated from `config/qtiauth.schema.json` by `pnpm config:reference`; do not edit by hand.

For how config is loaded, validated and referenced from `.env`, see [configuration.md](configuration.md). For what each section is for, see the service-specific docs linked from there.

## `branding`

Product and company branding.

| Setting                   | Type           | Default                 | Description                                                               |
| ------------------------- | -------------- | ----------------------- | ------------------------------------------------------------------------- |
| `branding`                | object         | `{}`                    | Product and company branding.                                             |
| `branding.product_name`   | string         | `"Example Account"`     | Product name shown to users. (≥ 1 characters)                             |
| `branding.company_name`   | string         | `"Example Ltd"`         | Company name used in legal text and emails. (≥ 1 characters)              |
| `branding.support_email`  | string         | `"support@example.com"` | Support contact address shown to users. (email)                           |
| `branding.logo`           | string \| null | `null`                  | Logo path, relative to the config directory. null shows the product name. |
| `branding.colors`         | object         | `{}`                    | Brand colours.                                                            |
| `branding.colors.primary` | string         | `"#3b82f6"`             | Primary brand colour.                                                     |

## `surfaces`

Where each web surface is served.

| Setting                      | Type                                                                          | Default                                          | Description                                                                                                                             |
| ---------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `surfaces`                   | object                                                                        | `{}`                                             | Where each web surface is served.                                                                                                       |
| `surfaces.account`           | object                                                                        | `{"hosts":["localhost"],"base_path":"/"}`        | Main account site and primary sign-in surface.                                                                                          |
| `surfaces.account.hosts`     | string[]                                                                      | `[]`                                             | Hostnames this surface answers on.                                                                                                      |
| `surfaces.account.ports`     | integer[]                                                                     | `[]`                                             | Ports this surface answers on, for host-less setups.                                                                                    |
| `surfaces.account.base_path` | string                                                                        | `"/"`                                            | Path prefix the surface is mounted under.                                                                                               |
| `surfaces.account.modules`   | "identity" \| "oidc" \| "games" \| "safety" \| "support" \| "admin"[] \| null | `null`                                           | Modules this surface owns. null uses the default ownership.                                                                             |
| `surfaces.account.origins`   | string[] \| null                                                              | `null`                                           | Public origins browsers use for this surface, for CORS, the Origin check and feature discovery. null uses https://<host> for each host. |
| `surfaces.support`           | object                                                                        | `{"hosts":["localhost"],"base_path":"/support"}` | Help centre.                                                                                                                            |
| `surfaces.support.hosts`     | string[]                                                                      | `[]`                                             | Hostnames this surface answers on.                                                                                                      |
| `surfaces.support.ports`     | integer[]                                                                     | `[]`                                             | Ports this surface answers on, for host-less setups.                                                                                    |
| `surfaces.support.base_path` | string                                                                        | `"/"`                                            | Path prefix the surface is mounted under.                                                                                               |
| `surfaces.support.modules`   | "identity" \| "oidc" \| "games" \| "safety" \| "support" \| "admin"[] \| null | `null`                                           | Modules this surface owns. null uses the default ownership.                                                                             |
| `surfaces.support.origins`   | string[] \| null                                                              | `null`                                           | Public origins browsers use for this surface, for CORS, the Origin check and feature discovery. null uses https://<host> for each host. |
| `surfaces.api`               | object                                                                        | `{"hosts":["localhost"],"base_path":"/api"}`     | Non-browser clients: games, game servers and third-party apps.                                                                          |
| `surfaces.api.hosts`         | string[]                                                                      | `[]`                                             | Hostnames this surface answers on.                                                                                                      |
| `surfaces.api.ports`         | integer[]                                                                     | `[]`                                             | Ports this surface answers on, for host-less setups.                                                                                    |
| `surfaces.api.base_path`     | string                                                                        | `"/"`                                            | Path prefix the surface is mounted under.                                                                                               |
| `surfaces.api.modules`       | "identity" \| "oidc" \| "games" \| "safety" \| "support" \| "admin"[] \| null | `null`                                           | Modules this surface owns. null uses the default ownership.                                                                             |
| `surfaces.api.origins`       | string[] \| null                                                              | `null`                                           | Public origins browsers use for this surface, for CORS, the Origin check and feature discovery. null uses https://<host> for each host. |

## `cookies`

Session cookie settings.

| Setting                | Type           | Default             | Description                                                                                    |
| ---------------------- | -------------- | ------------------- | ---------------------------------------------------------------------------------------------- |
| `cookies`              | object         | `{}`                | Session cookie settings.                                                                       |
| `cookies.name`         | string         | `"qtiauth_session"` | Session cookie name. Gets the __Host- prefix when domain is null.                              |
| `cookies.domain`       | string \| null | `null`              | Shared cookie domain. null uses host-only __Host- cookies.                                     |
| `cookies.session_ttl`  | duration       | `"7d"`              | Maximum session lifetime. Written as <integer><unit> (ms, s, m, h, d, w).                      |
| `cookies.idle_timeout` | duration       | `"30d"`             | Session ends after this long without activity. Written as <integer><unit> (ms, s, m, h, d, w). |

## `cors`

Cross-origin requests.

| Setting                | Type     | Default | Description                                                               |
| ---------------------- | -------- | ------- | ------------------------------------------------------------------------- |
| `cors`                 | object   | `{}`    | Cross-origin requests.                                                    |
| `cors.allowed_origins` | string[] | `[]`    | Extra credentialed CORS origins. Surface origins are added automatically. |

## `network`

Network settings.

| Setting                   | Type     | Default | Description                                            |
| ------------------------- | -------- | ------- | ------------------------------------------------------ |
| `network`                 | object   | `{}`    | Network settings.                                      |
| `network.trusted_proxies` | string[] | `[]`    | Proxies whose forwarded client IP headers are trusted. |

## `geoip`

IP geolocation.

| Setting               | Type                                           | Default                                             | Description                                                                                                      |
| --------------------- | ---------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `geoip`               | object                                         | `{}`                                                | IP geolocation.                                                                                                  |
| `geoip.source`        | "dbip_lite" \| "maxmind" \| "header" \| "none" | `"dbip_lite"`                                       | Where IP geolocation comes from.                                                                                 |
| `geoip.header`        | string \| null                                 | `null`                                              | Request header holding the country code when source is header.                                                   |
| `geoip.database_path` | string                                         | `"/var/lib/qtiauth/geoip/dbip-country-lite.csv.gz"` | Country database file. DB-IP Lite CSV or gzipped CSV, or a MaxMind MMDB when source is maxmind. (≥ 1 characters) |

## `text_filter`

Public-text filter.

| Setting                 | Type   | Default            | Description                                                                                                                                               |
| ----------------------- | ------ | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `text_filter`           | object | `{}`               | Public-text filter.                                                                                                                                       |
| `text_filter.lists_dir` | string | `"lists/username"` | Word-list directory, relative to the config file. Holds LDNOOBW, the dictionary, names, surnames, places, allow.txt and extra-block.txt. (≥ 1 characters) |

## `database`

PostgreSQL connection.

| Setting                            | Type                                    | Default              | Description                                                                                       |
| ---------------------------------- | --------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------- |
| `database`                         | object                                  | `{}`                 | PostgreSQL connection.                                                                            |
| `database.host`                    | string                                  | `"postgres"`         | Postgres host. (≥ 1 characters)                                                                   |
| `database.port`                    | integer                                 | `5432`               | Postgres port. (1–65535)                                                                          |
| `database.name`                    | string                                  | `"qtiauth"`          | Database name. (≥ 1 characters)                                                                   |
| `database.ssl`                     | "disable" \| "require" \| "verify-full" | `"disable"`          | TLS to Postgres. require encrypts without checking the certificate, verify-full also checks it.   |
| `database.pool`                    | object                                  | `{}`                 | Connection pool.                                                                                  |
| `database.pool.max`                | integer                                 | `10`                 | Maximum connections per service replica. (1–9007199254740991)                                     |
| `database.pool.idle_timeout`       | duration                                | `"30s"`              | Close idle connections after this long. Written as <integer><unit> (ms, s, m, h, d, w).           |
| `database.pool.connect_timeout`    | duration                                | `"10s"`              | Give up connecting after this long. Written as <integer><unit> (ms, s, m, h, d, w).               |
| `database.roles`                   | object                                  | `{}`                 | One role per service schema. Each role can only use its own schema.                               |
| `database.roles.identity`          | object                                  | `{}`                 | Credentials for the service that owns the identity schema.                                        |
| `database.roles.identity.user`     | string                                  | `"qtiauth_identity"` | Postgres role for the identity schema. (≥ 1 characters)                                           |
| `database.roles.identity.password` | string                                  | `""`                 | The role's password. Reference a secret.                                                          |
| `database.roles.notify`            | object                                  | `{}`                 | Credentials for the service that owns the notify schema.                                          |
| `database.roles.notify.user`       | string                                  | `"qtiauth_notify"`   | Postgres role for the notify schema. (≥ 1 characters)                                             |
| `database.roles.notify.password`   | string                                  | `""`                 | The role's password. Reference a secret.                                                          |
| `database.roles.oidc`              | object                                  | `{}`                 | Credentials for the service that owns the oidc schema.                                            |
| `database.roles.oidc.user`         | string                                  | `"qtiauth_oidc"`     | Postgres role for the oidc schema. (≥ 1 characters)                                               |
| `database.roles.oidc.password`     | string                                  | `""`                 | The role's password. Reference a secret.                                                          |
| `database.roles.safety`            | object                                  | `{}`                 | Credentials for the service that owns the safety schema.                                          |
| `database.roles.safety.user`       | string                                  | `"qtiauth_safety"`   | Postgres role for the safety schema. (≥ 1 characters)                                             |
| `database.roles.safety.password`   | string                                  | `""`                 | The role's password. Reference a secret.                                                          |
| `database.roles.support`           | object                                  | `{}`                 | Credentials for the service that owns the support schema.                                         |
| `database.roles.support.user`      | string                                  | `"qtiauth_support"`  | Postgres role for the support schema. (≥ 1 characters)                                            |
| `database.roles.support.password`  | string                                  | `""`                 | The role's password. Reference a secret.                                                          |
| `database.roles.games`             | object                                  | `{}`                 | Credentials for the service that owns the games schema.                                           |
| `database.roles.games.user`        | string                                  | `"qtiauth_games"`    | Postgres role for the games schema. (≥ 1 characters)                                              |
| `database.roles.games.password`    | string                                  | `""`                 | The role's password. Reference a secret.                                                          |
| `database.audit`                   | object                                  | `{}`                 | Postgres role for the audit log. Identity grants it INSERT and SELECT only on identity.audit_log. |
| `database.audit.user`              | string                                  | `"qtiauth_audit"`    | Postgres role for the audit log. (≥ 1 characters)                                                 |
| `database.audit.password`          | string                                  | `""`                 | The role's password. Reference a secret.                                                          |

## `migrations`

Database migrations.

| Setting                 | Type    | Default | Description                                              |
| ----------------------- | ------- | ------- | -------------------------------------------------------- |
| `migrations`            | object  | `{}`    | Database migrations.                                     |
| `migrations.auto_apply` | boolean | `true`  | Apply pending database migrations when a service starts. |

## `bus`

NATS JetStream message bus.

| Setting                          | Type           | Default                | Description                                                                                                                          |
| -------------------------------- | -------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `bus`                            | object         | `{}`                   | NATS JetStream message bus.                                                                                                          |
| `bus.servers`                    | string[]       | `["nats://nats:4222"]` | NATS servers to connect to. (≥ 1 items)                                                                                              |
| `bus.user`                       | string \| null | `null`                 | NATS user. null connects without credentials.                                                                                        |
| `bus.password`                   | string         | `""`                   | The NATS user's password. Reference a secret.                                                                                        |
| `bus.tls`                        | object         | `{}`                   | TLS to NATS.                                                                                                                         |
| `bus.tls.required`               | boolean        | `false`                | Refuse to connect without TLS. TLS is used anyway when the server offers it.                                                         |
| `bus.tls.ca_file`                | string \| null | `null`                 | CA certificate file for verifying the server. null uses the system CAs.                                                              |
| `bus.connect_timeout`            | duration       | `"10s"`                | Give up connecting after this long. Written as <integer><unit> (ms, s, m, h, d, w).                                                  |
| `bus.request_timeout`            | duration       | `"5s"`                 | Default deadline for request/reply calls between services. Written as <integer><unit> (ms, s, m, h, d, w).                           |
| `bus.streams`                    | object         | `{}`                   | JetStream streams, created or updated when a service starts.                                                                         |
| `bus.streams.replicas`           | integer        | `1`                    | JetStream replicas per stream. Use 3 on a NATS cluster. (1–5)                                                                        |
| `bus.streams.events_max_age`     | duration       | `"7d"`                 | Keep domain events in the stream for this long. Written as <integer><unit> (ms, s, m, h, d, w).                                      |
| `bus.streams.work_max_age`       | duration       | `"7d"`                 | Drop cron ticks and work-queue jobs nobody took after this long. Written as <integer><unit> (ms, s, m, h, d, w).                     |
| `bus.streams.duplicate_window`   | duration       | `"2m"`                 | JetStream drops a message whose ID it has already seen within this window. Written as <integer><unit> (ms, s, m, h, d, w).           |
| `bus.outbox`                     | object         | `{}`                   | Transactional outbox relay.                                                                                                          |
| `bus.outbox.poll_interval`       | duration       | `"1s"`                 | Check the outbox for unsent events this often. Written as <integer><unit> (ms, s, m, h, d, w).                                       |
| `bus.outbox.batch_size`          | integer        | `100`                  | Events published per outbox transaction. (1–1000)                                                                                    |
| `bus.outbox.sent_retention`      | duration       | `"1d"`                 | Delete published events from the outbox after this long. Written as <integer><unit> (ms, s, m, h, d, w).                             |
| `bus.consumers`                  | object         | `{}`                   | Event, cron and work-queue consumers.                                                                                                |
| `bus.consumers.ack_wait`         | duration       | `"30s"`                | Redeliver a message if a consumer neither acks nor extends it. Written as <integer><unit> (ms, s, m, h, d, w).                       |
| `bus.consumers.max_deliver`      | integer        | `10`                   | Give up on a message after this many delivery attempts. (1–9007199254740991)                                                         |
| `bus.consumers.retry_delay`      | duration       | `"1s"`                 | Delay before the first retry. Doubles with each attempt. Written as <integer><unit> (ms, s, m, h, d, w).                             |
| `bus.consumers.max_retry_delay`  | duration       | `"5m"`                 | Longest delay between retries. Written as <integer><unit> (ms, s, m, h, d, w).                                                       |
| `bus.consumers.dedupe_retention` | duration       | `"14d"`                | Remember processed event IDs for this long. Must be at least streams.events_max_age. Written as <integer><unit> (ms, s, m, h, d, w). |

## `observability`

Logs, traces, metrics and health checks.

| Setting                                 | Type                                                         | Default                         | Description                                                                                                                    |
| --------------------------------------- | ------------------------------------------------------------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `observability`                         | object                                                       | `{}`                            | Logs, traces, metrics and health checks.                                                                                       |
| `observability.logs`                    | object                                                       | `{}`                            | Structured JSON logs, written to standard output.                                                                              |
| `observability.logs.level`              | "trace" \| "debug" \| "info" \| "warn" \| "error" \| "fatal" | `"info"`                        | Lowest level written to the log.                                                                                               |
| `observability.logs.user_id_hash_key`   | string                                                       | `""`                            | Key for hashing user IDs in logs. Use the same key on every service so logs can be joined. Reference a secret.                 |
| `observability.logs.redact_keys`        | string[]                                                     | `[]`                            | Extra field names whose values are never logged, on top of the built-in list (passwords, tokens, secrets, codes and the like). |
| `observability.tracing`                 | object                                                       | `{}`                            | OpenTelemetry tracing.                                                                                                         |
| `observability.tracing.enabled`         | boolean                                                      | `false`                         | Send traces to an OTLP collector. Trace IDs are still created, logged and passed between services when off.                    |
| `observability.tracing.endpoint`        | string                                                       | `"http://tempo:4318/v1/traces"` | OTLP/HTTP traces endpoint. (uri)                                                                                               |
| `observability.tracing.sample_ratio`    | number                                                       | `1`                             | Share of traces to keep, from 0 to 1. Every service must use the same value. (0–1)                                             |
| `observability.metrics`                 | object                                                       | `{}`                            | Prometheus metrics, served on /metrics on the internal network.                                                                |
| `observability.metrics.process_metrics` | boolean                                                      | `true`                          | Also report Node.js process metrics (CPU, memory, event loop, GC).                                                             |
| `observability.health`                  | object                                                       | `{}`                            | Health endpoints.                                                                                                              |
| `observability.health.check_timeout`    | duration                                                     | `"2s"`                          | Count a /readyz dependency check as failed if it takes longer than this. Written as <integer><unit> (ms, s, m, h, d, w).       |

## `service`

Settings shared by every service.

| Setting                                   | Type     | Default | Description                                                                                                                                                        |
| ----------------------------------------- | -------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `service`                                 | object   | `{}`    | Settings shared by every service.                                                                                                                                  |
| `service.http`                            | object   | `{}`    | Internal HTTP server.                                                                                                                                              |
| `service.http.port`                       | integer  | `8080`  | Port each service listens on, on the internal network. (1–65535)                                                                                                   |
| `service.http.shutdown_timeout`           | duration | `"15s"` | On SIGTERM or SIGINT, wait this long for in-flight requests and background work before exiting anyway. Written as <integer><unit> (ms, s, m, h, d, w).             |
| `service.identity_tokens`                 | object   | `{}`    | Internal identity tokens minted by the gateway (X-QTIAuth-Identity).                                                                                               |
| `service.identity_tokens.clock_tolerance` | duration | `"5s"`  | Allowed clock difference between the gateway and a service when checking internal identity token times. Written as <integer><unit> (ms, s, m, h, d, w).            |
| `service.identity_tokens.keys_refresh`    | duration | `"5m"`  | Fetch the gateway's identity token public keys this often. Keys the service hasn't seen are fetched straight away. Written as <integer><unit> (ms, s, m, h, d, w). |

## `valkey`

Valkey, for rate limits, the session cache and short-lived state.

| Setting                  | Type           | Default    | Description                                                                                                        |
| ------------------------ | -------------- | ---------- | ------------------------------------------------------------------------------------------------------------------ |
| `valkey`                 | object         | `{}`       | Valkey, for rate limits, the session cache and short-lived state.                                                  |
| `valkey.host`            | string         | `"valkey"` | Valkey host. (≥ 1 characters)                                                                                      |
| `valkey.port`            | integer        | `6379`     | Valkey port. (1–65535)                                                                                             |
| `valkey.user`            | string \| null | `null`     | Valkey ACL user. null uses the default user.                                                                       |
| `valkey.password`        | string         | `""`       | Valkey password. Empty connects without one. Reference a secret.                                                   |
| `valkey.database`        | integer        | `0`        | Logical database number. (0–9007199254740991)                                                                      |
| `valkey.tls`             | object         | `{}`       | TLS to Valkey.                                                                                                     |
| `valkey.tls.enabled`     | boolean        | `false`    | Connect over TLS.                                                                                                  |
| `valkey.tls.ca_file`     | string \| null | `null`     | CA certificate file for verifying the server. null uses the system CAs.                                            |
| `valkey.connect_timeout` | duration       | `"5s"`     | Give up connecting after this long. Written as <integer><unit> (ms, s, m, h, d, w).                                |
| `valkey.command_timeout` | duration       | `"1s"`     | Treat Valkey as unavailable when a command takes longer than this. Written as <integer><unit> (ms, s, m, h, d, w). |

## `gateway`

Gateway: the single public entry point.

| Setting                                       | Type                | Default   | Description                                                                                                                                       |
| --------------------------------------------- | ------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gateway`                                     | object              | `{}`      | Gateway: the single public entry point.                                                                                                           |
| `gateway.http`                                | object              | `{}`      | Public HTTP listener.                                                                                                                             |
| `gateway.http.port`                           | integer             | `8000`    | Public port for surfaces bound to hosts. Surfaces bound to ports listen on their own ports. (1–65535)                                             |
| `gateway.http.max_body_size`                  | integer             | `1048576` | Largest request body the gateway accepts, in bytes. (1–9007199254740991)                                                                          |
| `gateway.http.upstream_timeout`               | duration            | `"30s"`   | Give up on a service response after this long. Written as <integer><unit> (ms, s, m, h, d, w).                                                    |
| `gateway.upstreams`                           | map<string, string> | `{}`      | Base URL per service. Services not listed are reached at http://<service>:<service.http.port>.                                                    |
| `gateway.discovery`                           | object              | `{}`      | Service discovery over qtiauth.sys.announce.                                                                                                      |
| `gateway.discovery.interval`                  | duration            | `"30s"`   | Ask every service to announce itself this often. Written as <integer><unit> (ms, s, m, h, d, w).                                                  |
| `gateway.discovery.expiry`                    | duration            | `"90s"`   | Forget a service instance that hasn't announced itself for this long. Written as <integer><unit> (ms, s, m, h, d, w).                             |
| `gateway.discovery.startup_grace`             | duration            | `"5s"`    | After starting, wait this long for announcements before reporting services that aren't running. Written as <integer><unit> (ms, s, m, h, d, w).   |
| `gateway.session_cache`                       | object              | `{}`      | Session lookup cache.                                                                                                                             |
| `gateway.session_cache.ttl`                   | duration            | `"1m"`    | Keep a resolved session in Valkey for this long. Revocations and account changes clear it sooner. Written as <integer><unit> (ms, s, m, h, d, w). |
| `gateway.identity_keys`                       | object              | `{}`      | Signing keys for internal identity tokens (X-QTIAuth-Identity).                                                                                   |
| `gateway.identity_keys.encryption_key`        | string              | `""`      | Base64 32-byte key that encrypts the signing keys at rest. Required to start the gateway. Reference a secret.                                     |
| `gateway.identity_keys.rotate_after`          | duration            | `"30d"`   | Replace the signing key once it is this old. Written as <integer><unit> (ms, s, m, h, d, w).                                                      |
| `gateway.identity_keys.retain_after_rotation` | duration            | `"1h"`    | Keep publishing a replaced key for this long, so tokens it signed can still be checked. Written as <integer><unit> (ms, s, m, h, d, w).           |
| `gateway.identity_keys.refresh`               | duration            | `"30s"`   | Reload signing keys from the store this often, so other gateway replicas pick up a rotation. Written as <integer><unit> (ms, s, m, h, d, w).      |
| `gateway.hsts`                                | object              | `{}`      | Strict-Transport-Security header.                                                                                                                 |
| `gateway.hsts.max_age`                        | duration            | `"365d"`  | How long browsers remember to use HTTPS only. Written as <integer><unit> (ms, s, m, h, d, w).                                                     |
| `gateway.hsts.include_subdomains`             | boolean             | `false`   | Apply HSTS to every subdomain of each surface host too.                                                                                           |
| `gateway.hsts.preload`                        | boolean             | `false`   | Ask to be included in browser preload lists.                                                                                                      |

## `features`

Feature flags inside services.

| Setting                                              | Type     | Default | Description                                                                   |
| ---------------------------------------------------- | -------- | ------- | ----------------------------------------------------------------------------- |
| `features`                                           | object   | `{}`    | Feature flags inside services.                                                |
| `features.auth`                                      | object   | `{}`    | Authentication methods.                                                       |
| `features.auth.password`                             | object   | `{}`    | password sign-in                                                              |
| `features.auth.password.enabled`                     | boolean  | `true`  | Enable password sign-in.                                                      |
| `features.auth.magic_link`                           | object   | `{}`    | magic link sign-in                                                            |
| `features.auth.magic_link.enabled`                   | boolean  | `true`  | Enable magic link sign-in.                                                    |
| `features.auth.passkeys`                             | object   | `{}`    | passkeys                                                                      |
| `features.auth.passkeys.enabled`                     | boolean  | `true`  | Enable passkeys.                                                              |
| `features.auth.totp`                                 | object   | `{}`    | TOTP two-factor                                                               |
| `features.auth.totp.enabled`                         | boolean  | `true`  | Enable TOTP two-factor.                                                       |
| `features.auth.social`                               | object   | `{}`    | Social and upstream sign-in.                                                  |
| `features.auth.social.google`                        | object   | `{}`    | Google sign-in.                                                               |
| `features.auth.social.google.enabled`                | boolean  | `false` | Enable sign-in with Google.                                                   |
| `features.auth.social.google.client_id`              | string   | `""`    | OAuth client ID.                                                              |
| `features.auth.social.google.client_secret`          | string   | `""`    | OAuth client secret. Reference a secret.                                      |
| `features.auth.social.github`                        | object   | `{}`    | GitHub sign-in.                                                               |
| `features.auth.social.github.enabled`                | boolean  | `false` | Enable sign-in with GitHub.                                                   |
| `features.auth.social.github.client_id`              | string   | `""`    | OAuth client ID.                                                              |
| `features.auth.social.github.client_secret`          | string   | `""`    | OAuth client secret. Reference a secret.                                      |
| `features.auth.social.discord`                       | object   | `{}`    | Discord sign-in.                                                              |
| `features.auth.social.discord.enabled`               | boolean  | `false` | Enable sign-in with Discord.                                                  |
| `features.auth.social.discord.client_id`             | string   | `""`    | OAuth client ID.                                                              |
| `features.auth.social.discord.client_secret`         | string   | `""`    | OAuth client secret. Reference a secret.                                      |
| `features.auth.social.steam`                         | object   | `{}`    | Steam sign-in                                                                 |
| `features.auth.social.steam.enabled`                 | boolean  | `false` | Enable Steam sign-in.                                                         |
| `features.auth.social.generic_oidc`                  | object[] | `[]`    | Upstream OIDC providers.                                                      |
| `features.session_security`                          | object   | `{}`    | session security checks                                                       |
| `features.session_security.enabled`                  | boolean  | `true`  | Enable session security checks.                                               |
| `features.oidc`                                      | object   | `{}`    | OIDC provider features (oidc profile).                                        |
| `features.oidc.developer_portal`                     | object   | `{}`    | the developer portal                                                          |
| `features.oidc.developer_portal.enabled`             | boolean  | `true`  | Enable the developer portal.                                                  |
| `features.oidc.backchannel_logout`                   | object   | `{}`    | back-channel logout                                                           |
| `features.oidc.backchannel_logout.enabled`           | boolean  | `true`  | Enable back-channel logout.                                                   |
| `features.games`                                     | object   | `{}`    | Games features (games profile).                                               |
| `features.games.licensing`                           | object   | `{}`    | offline licensing                                                             |
| `features.games.licensing.enabled`                   | boolean  | `true`  | Enable offline licensing.                                                     |
| `features.games.steam`                               | object   | `{}`    | Steam integration                                                             |
| `features.games.steam.enabled`                       | boolean  | `false` | Enable Steam integration.                                                     |
| `features.games.leaderboards`                        | object   | `{}`    | Leaderboards.                                                                 |
| `features.games.leaderboards.enabled`                | boolean  | `true`  | Enable leaderboards.                                                          |
| `features.games.leaderboards.require_game_authority` | boolean  | `true`  | Leaderboard scores need the game server's credential as well as the player's. |
| `features.games.playtime`                            | object   | `{}`    | playtime tracking                                                             |
| `features.games.playtime.enabled`                    | boolean  | `true`  | Enable playtime tracking.                                                     |
| `features.games.cloud_saves`                         | object   | `{}`    | cloud saves (needs object storage)                                            |
| `features.games.cloud_saves.enabled`                 | boolean  | `false` | Enable cloud saves (needs object storage).                                    |
| `features.games.keys`                                | object   | `{}`    | key redemption                                                                |
| `features.games.keys.enabled`                        | boolean  | `true`  | Enable key redemption.                                                        |
| `features.support`                                   | object   | `{}`    | Support features (support profile).                                           |
| `features.support.tickets`                           | object   | `{}`    | support tickets                                                               |
| `features.support.tickets.enabled`                   | boolean  | `true`  | Enable support tickets.                                                       |
| `features.support.kb`                                | object   | `{}`    | the knowledge base                                                            |
| `features.support.kb.enabled`                        | boolean  | `true`  | Enable the knowledge base.                                                    |
| `features.support.guest_tickets`                     | object   | `{}`    | tickets from signed-out users                                                 |
| `features.support.guest_tickets.enabled`             | boolean  | `true`  | Enable tickets from signed-out users.                                         |
| `features.support.attachments`                       | object   | `{}`    | ticket attachments (needs object storage)                                     |
| `features.support.attachments.enabled`               | boolean  | `false` | Enable ticket attachments (needs object storage).                             |
| `features.safety`                                    | object   | `{}`    | Safety features (safety profile).                                             |
| `features.safety.reports`                            | object   | `{}`    | user, content and game report intake                                          |
| `features.safety.reports.enabled`                    | boolean  | `true`  | Enable user, content and game report intake.                                  |
| `features.safety.game_intake`                        | object   | `{}`    | the game and service report intake API                                        |
| `features.safety.game_intake.enabled`                | boolean  | `true`  | Enable the game and service report intake API.                                |
| `features.safety.automated_flags`                    | object   | `{}`    | automated flag intake from games and services                                 |
| `features.safety.automated_flags.enabled`            | boolean  | `true`  | Enable automated flag intake from games and services.                         |
| `features.safety.moderation`                         | object   | `{}`    | the moderation queue, actions and two-person bans                             |
| `features.safety.moderation.enabled`                 | boolean  | `true`  | Enable the moderation queue, actions and two-person bans.                     |
| `features.safety.appeals`                            | object   | `{}`    | appeals against locks, bans and restrictions                                  |
| `features.safety.appeals.enabled`                    | boolean  | `true`  | Enable appeals against locks, bans and restrictions.                          |
| `features.safety.csea`                               | object   | `{}`    | the CSEA / NCA case workflow                                                  |
| `features.safety.csea.enabled`                       | boolean  | `true`  | Enable the CSEA / NCA case workflow.                                          |

## `captcha`

Bot protection. Shown after captcha.after attempts from an IP, then required.

| Setting                               | Type                                                                  | Default    | Description                                                                                                                                                         |
| ------------------------------------- | --------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `captcha`                             | object                                                                | `{}`       | Bot protection. Shown after captcha.after attempts from an IP, then required.                                                                                       |
| `captcha.provider`                    | "altcha" \| "turnstile" \| "hcaptcha" \| "friendly_captcha" \| "none" | `"altcha"` | CAPTCHA provider. altcha is self-hosted proof-of-work. none disables CAPTCHA. The others verify with that vendor.                                                   |
| `captcha.after`                       | integer                                                               | `3`        | Show a CAPTCHA after this many failed password attempts from an IP, or this many signup or magic-link starts from an IP. 0 shows it on the first attempt. (0–10000) |
| `captcha.window`                      | duration                                                              | `"15m"`    | Attempts older than this do not count towards the CAPTCHA threshold. Written as <integer><unit> (ms, s, m, h, d, w).                                                |
| `captcha.altcha`                      | object                                                                | `{}`       | Altcha (self-hosted proof-of-work).                                                                                                                                 |
| `captcha.altcha.hmac_key`             | string                                                                | `""`       | HMAC key for Altcha challenges. Empty generates a key at startup; set it when running more than one identity replica.                                               |
| `captcha.altcha.max_number`           | integer                                                               | `100000`   | Altcha proof-of-work upper bound. Higher is harder for the client. (100–10000000)                                                                                   |
| `captcha.altcha.expires`              | duration                                                              | `"2m"`     | An Altcha challenge works for this long. Written as <integer><unit> (ms, s, m, h, d, w).                                                                            |
| `captcha.turnstile`                   | object                                                                | `{}`       | Cloudflare Turnstile settings.                                                                                                                                      |
| `captcha.turnstile.site_key`          | string                                                                | `""`       | Cloudflare Turnstile site key, public in the widget.                                                                                                                |
| `captcha.turnstile.secret_key`        | string                                                                | `""`       | Cloudflare Turnstile secret key. Reference a secret.                                                                                                                |
| `captcha.hcaptcha`                    | object                                                                | `{}`       | hCaptcha settings.                                                                                                                                                  |
| `captcha.hcaptcha.site_key`           | string                                                                | `""`       | hCaptcha site key, public in the widget.                                                                                                                            |
| `captcha.hcaptcha.secret_key`         | string                                                                | `""`       | hCaptcha secret key. Reference a secret.                                                                                                                            |
| `captcha.friendly_captcha`            | object                                                                | `{}`       | Friendly Captcha settings.                                                                                                                                          |
| `captcha.friendly_captcha.site_key`   | string                                                                | `""`       | Friendly Captcha site key, public in the widget.                                                                                                                    |
| `captcha.friendly_captcha.secret_key` | string                                                                | `""`       | Friendly Captcha secret key. Reference a secret.                                                                                                                    |

## `email`

Outgoing email.

| Setting                       | Type                          | Default                  | Description                                                                                                                                                               |
| ----------------------------- | ----------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `email`                       | object                        | `{}`                     | Outgoing email.                                                                                                                                                           |
| `email.provider`              | "smtp" \| "console"           | `"smtp"`                 | Email delivery provider. console prints emails instead of sending them.                                                                                                   |
| `email.from`                  | object                        | `{}`                     | Sender identities.                                                                                                                                                        |
| `email.from.auth`             | object                        | `{}`                     | Sender for sign-in and verification email.                                                                                                                                |
| `email.from.auth.name`        | string                        | `"Example Auth"`         | Display name. (≥ 1 characters)                                                                                                                                            |
| `email.from.auth.address`     | string                        | `"auth@example.com"`     | Email address. (email)                                                                                                                                                    |
| `email.from.security`         | object                        | `{}`                     | Sender for security alert email.                                                                                                                                          |
| `email.from.security.name`    | string                        | `"Example Security"`     | Display name. (≥ 1 characters)                                                                                                                                            |
| `email.from.security.address` | string                        | `"security@example.com"` | Email address. (email)                                                                                                                                                    |
| `email.from.support`          | object                        | `{}`                     | Sender for support email.                                                                                                                                                 |
| `email.from.support.name`     | string                        | `"Example Support"`      | Display name. (≥ 1 characters)                                                                                                                                            |
| `email.from.support.address`  | string                        | `"support@example.com"`  | Email address. (email)                                                                                                                                                    |
| `email.default_locale`        | string                        | `"en-GB"`                | Locale used when an email's locale has no templates. Every template must exist in this locale.                                                                            |
| `email.templates_dir`         | string                        | `"templates/email"`      | Directory of template overrides, one subdirectory per locale, relative to the config directory. A file here replaces the built-in file of the same name. (≥ 1 characters) |
| `email.smtp`                  | object                        | `{}`                     | SMTP provider settings.                                                                                                                                                   |
| `email.smtp.host`             | string                        | `"localhost"`            | SMTP server host. (≥ 1 characters)                                                                                                                                        |
| `email.smtp.port`             | integer                       | `587`                    | SMTP server port. (1–65535)                                                                                                                                               |
| `email.smtp.security`         | "starttls" \| "tls" \| "none" | `"starttls"`             | starttls upgrades the connection and refuses servers that cannot, tls connects over TLS (usually port 465), none never uses TLS.                                          |
| `email.smtp.user`             | string \| null                | `null`                   | SMTP user. null sends without authenticating.                                                                                                                             |
| `email.smtp.password`         | string                        | `""`                     | The SMTP user's password. Reference a secret.                                                                                                                             |
| `email.smtp.connect_timeout`  | duration                      | `"10s"`                  | Give up connecting after this long. Written as <integer><unit> (ms, s, m, h, d, w).                                                                                       |
| `email.smtp.send_timeout`     | duration                      | `"30s"`                  | Give up on a send when the server goes quiet for this long. Written as <integer><unit> (ms, s, m, h, d, w).                                                               |
| `email.queue`                 | object                        | `{}`                     | Outgoing email queue. With the defaults, an email is retried for about 6 hours before it fails.                                                                           |
| `email.queue.max_attempts`    | integer                       | `20`                     | Try sending an email this many times before marking it failed. (1–9007199254740991)                                                                                       |
| `email.queue.retry_delay`     | duration                      | `"10s"`                  | Delay before the first retry. Doubles with each attempt. Written as <integer><unit> (ms, s, m, h, d, w).                                                                  |
| `email.queue.max_retry_delay` | duration                      | `"30m"`                  | Longest delay between retries. Written as <integer><unit> (ms, s, m, h, d, w).                                                                                            |

## `webhooks`

Outbound webhooks.

| Setting                           | Type                | Default | Description                                                                                                                    |
| --------------------------------- | ------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `webhooks`                        | object              | `{}`    | Outbound webhooks.                                                                                                             |
| `webhooks.allow_private_targets`  | boolean             | `false` | Allow URLs whose DNS resolves to private, loopback or link-local addresses. Off by default.                                    |
| `webhooks.disable_after_failures` | integer             | `50`    | Disable an endpoint after this many consecutive failed deliveries, and email admins. (1–9007199254740991)                      |
| `webhooks.timeout`                | duration            | `"10s"` | Give up on a delivery when the target is quiet for this long. Written as <integer><unit> (ms, s, m, h, d, w).                  |
| `webhooks.retry_window`           | duration            | `"24h"` | Keep retrying a failed delivery for this long, then mark it failed. Written as <integer><unit> (ms, s, m, h, d, w).            |
| `webhooks.retry_delay`            | duration            | `"1m"`  | Delay before the first retry. Doubles with each attempt. Written as <integer><unit> (ms, s, m, h, d, w).                       |
| `webhooks.max_retry_delay`        | duration            | `"1h"`  | Longest delay between retries. Written as <integer><unit> (ms, s, m, h, d, w).                                                 |
| `webhooks.secret_overlap`         | duration            | `"24h"` | How long the previous signing secret stays valid after rotation. Written as <integer><unit> (ms, s, m, h, d, w).               |
| `webhooks.endpoints`              | map<string, object> | `{}`    | Endpoints to seed on startup, keyed by slug. Existing slugs are left as they are; manage them with webhooks.manage after that. |

## `security`

Account security.

| Setting                                | Type     | Default                                                                                                                  | Description                                                                                                                        |
| -------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `security`                             | object   | `{}`                                                                                                                     | Account security.                                                                                                                  |
| `security.step_up_window`              | duration | `"10m"`                                                                                                                  | Routes that need step-up accept a session that reached aal2 within this long. Written as <integer><unit> (ms, s, m, h, d, w).      |
| `security.encryption_key`              | string   | `""`                                                                                                                     | Base64 32-byte key that encrypts TOTP secrets at rest. Required when TOTP is enabled. Reference a secret.                          |
| `security.require_2fa_for_permissions` | string[] | `["users.*","safety.*","support.*","games.*","oidc.clients.*","webhooks.manage","audit.read","roles.manage","filter.*"]` | Staff whose permissions match any of these must enrol a passkey or TOTP before using the rest of the product. Prefixes end in .* . |

## `roles`

Staff roles, keyed by slug. Built-ins are seeded on startup and can then be edited with roles.manage. * never matches permissions that must be granted by name.

| Setting | Type                | Default                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Description                                                                                                                                                     |
| ------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `roles` | map<string, object> | `{"admin":{"name":"Admin","description":"Full access, except permissions that must be granted by name.","permissions":["*"]},"moderator":{"name":"Moderator","description":"Moderate users, reports and the text filter.","permissions":["users.read","users.ban","users.lock","users.edit_dob","users.force_username_reset","safety.reports.read","safety.actions.apply","filter.read","filter.manage"]},"support_agent":{"name":"Support agent","description":"Handle support tickets.","permissions":["users.read","support.tickets.staff"]},"kb_editor":{"name":"Knowledge-base editor","description":"Edit knowledge-base articles.","permissions":["support.kb.edit"]},"game_manager":{"name":"Game manager","description":"Manage games, entitlements and keys.","permissions":["games.catalog.edit","games.entitlements.grant","games.keys.manage"]}}` | Staff roles, keyed by slug. Built-ins are seeded on startup and can then be edited with roles.manage. * never matches permissions that must be granted by name. |

## `accounts`

Accounts.

| Setting                           | Type                | Default                                                                                                                                                             | Description                                                                                                                                                                       |
| --------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `accounts`                        | object              | `{}`                                                                                                                                                                | Accounts.                                                                                                                                                                         |
| `accounts.max_per_email`          | integer             | `2`                                                                                                                                                                 | Accounts allowed per normalized email address. (1–9007199254740991)                                                                                                               |
| `accounts.email_normalization`    | map<string, object> | `{"gmail.com":{"remove_dots":true,"subaddress_separator":"+","domain":null},"googlemail.com":{"remove_dots":true,"subaddress_separator":"+","domain":"gmail.com"}}` | Rules per email domain for deciding when two addresses are the same, on top of ignoring case. Setting this replaces the built-in rules.                                           |
| `accounts.email_change_ttl`       | duration            | `"15m"`                                                                                                                                                             | The confirmation link sent to a new email address works for this long. Written as <integer><unit> (ms, s, m, h, d, w).                                                            |
| `accounts.email_revert_ttl`       | duration            | `"7d"`                                                                                                                                                              | The "this wasn't me" link sent to the previous email address works for this long. Written as <integer><unit> (ms, s, m, h, d, w).                                                 |
| `accounts.deletion_grace`         | duration            | `"30d"`                                                                                                                                                             | How long an account stays in pending_deletion after the user asks to delete it. Signing in during this time cancels the deletion. Written as <integer><unit> (ms, s, m, h, d, w). |
| `accounts.export_ttl`             | duration            | `"7d"`                                                                                                                                                              | How long a data-export download link works. After this the zip is deleted. Written as <integer><unit> (ms, s, m, h, d, w).                                                        |
| `accounts.export_email_max_bytes` | integer             | `524288`                                                                                                                                                            | Largest export that can be emailed as an attachment when object storage is not configured. Larger exports need storage. (1–10485760)                                              |

## `magic_link`

Magic-link sign-in.

| Setting                 | Type     | Default | Description                                                                                                                                |
| ----------------------- | -------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `magic_link`            | object   | `{}`    | Magic-link sign-in.                                                                                                                        |
| `magic_link.ttl`        | duration | `"15m"` | A magic link works for this long. Written as <integer><unit> (ms, s, m, h, d, w).                                                          |
| `magic_link.signup_ttl` | duration | `"30m"` | After a new user opens their magic link, they have this long to enter their date of birth. Written as <integer><unit> (ms, s, m, h, d, w). |

## `password`

Password sign-in.

| Setting                               | Type     | Default   | Description                                                                                                                                                        |
| ------------------------------------- | -------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `password`                            | object   | `{}`      | Password sign-in.                                                                                                                                                  |
| `password.min_length`                 | integer  | `10`      | Shortest a password can be. (1–256)                                                                                                                                |
| `password.max_length`                 | integer  | `256`     | Longest a password can be. 256 is the hard cap. (1–256)                                                                                                            |
| `password.composition`                | object   | `{}`      | Optional composition rules. All off by default.                                                                                                                    |
| `password.composition.require_lower`  | boolean  | `false`   | Require a lowercase letter.                                                                                                                                        |
| `password.composition.require_upper`  | boolean  | `false`   | Require an uppercase letter.                                                                                                                                       |
| `password.composition.require_digit`  | boolean  | `false`   | Require a digit.                                                                                                                                                   |
| `password.composition.require_symbol` | boolean  | `false`   | Require a character that is not a letter or digit.                                                                                                                 |
| `password.breach_check`               | boolean  | `true`    | Reject passwords that appear in the Have I Been Pwned range API. Only the first 5 hex characters of a SHA-1 hash leave the server. Unreachable checks are skipped. |
| `password.argon2`                     | object   | `{}`      | Argon2id parameters. Stored hashes are rehashed on login when these change.                                                                                        |
| `password.argon2.memory_kib`          | integer  | `19456`   | Argon2id memory in KiB. OWASP default is 19456 (19 MiB). (8–1048576)                                                                                               |
| `password.argon2.iterations`          | integer  | `2`       | Argon2id iterations (t). (1–16)                                                                                                                                    |
| `password.argon2.parallelism`         | integer  | `1`       | Argon2id parallelism (p). (1–16)                                                                                                                                   |
| `password.reset_ttl`                  | duration | `"15m"`   | A password reset link works for this long. Written as <integer><unit> (ms, s, m, h, d, w).                                                                         |
| `password.verification_ttl`           | duration | `"15m"`   | An email verification link after password signup works for this long. Written as <integer><unit> (ms, s, m, h, d, w).                                              |
| `password.failure_delay`              | object   | `{}`      | Progressive delay after failed password attempts, counted per account and per IP. There is no lockout.                                                             |
| `password.failure_delay.step`         | duration | `"250ms"` | Extra delay added for each previous failed password attempt on the account or IP. Written as <integer><unit> (ms, s, m, h, d, w).                                  |
| `password.failure_delay.max`          | duration | `"2s"`    | Longest progressive delay after failed password attempts. Written as <integer><unit> (ms, s, m, h, d, w).                                                          |

## `sessions`

Sessions.

| Setting                 | Type    | Default | Description                                                                              |
| ----------------------- | ------- | ------- | ---------------------------------------------------------------------------------------- |
| `sessions`              | object  | `{}`    | Sessions.                                                                                |
| `sessions.max_per_user` | integer | `10`    | Sessions a user can have at once. Signing in again ends the oldest. (1–9007199254740991) |

## `session_security`

Session security checks.

| Setting                                   | Type                                           | Default       | Description                                                                                                                                                         |
| ----------------------------------------- | ---------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session_security`                        | object                                         | `{}`          | Session security checks.                                                                                                                                            |
| `session_security.on_country_change`      | "challenge" \| "block" \| "notify" \| "ignore" | `"challenge"` | When a session moves to another country: challenge drops it to aal0 until the user signs in again, block ends it, notify allows it and emails, ignore does nothing. |
| `session_security.new_device_email`       | boolean                                        | `true`        | Email the user when they sign in from a browser or OS that has not been seen.                                                                                       |
| `session_security.tls_fingerprint`        | object                                         | `{}`          | Optional TLS fingerprint from an upstream proxy.                                                                                                                    |
| `session_security.tls_fingerprint.header` | string \| null                                 | `null`        | Request header holding a TLS fingerprint such as JA4. null turns this signal off.                                                                                   |
| `session_security.alert_min_interval`     | duration                                       | `"1h"`        | Shortest gap between security-alert emails to the same user. Written as <integer><unit> (ms, s, m, h, d, w).                                                        |

## `age`

Age bands, computed from the date of birth, and age assurance.

| Setting                          | Type                 | Default           | Description                                                                                                                    |
| -------------------------------- | -------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `age`                            | object               | `{}`              | Age bands, computed from the date of birth, and age assurance.                                                                 |
| `age.bands`                      | object               | `{}`              | Age in whole years at which each band starts. Anyone younger is under_13.                                                      |
| `age.bands.13_to_15`             | integer              | `13`              | Age the 13_to_15 band starts at. (1–150)                                                                                       |
| `age.bands.16_to_17`             | integer              | `16`              | Age the 16_to_17 band starts at. (1–150)                                                                                       |
| `age.bands.adult`                | integer              | `18`              | Age the adult band starts at. (1–150)                                                                                          |
| `age.assurance`                  | object               | `{}`              | Pluggable age assurance.                                                                                                       |
| `age.assurance.default_provider` | "self_declared"      | `"self_declared"` | Provider used when a trigger in required_for applies. Only self_declared ships.                                                |
| `age.assurance.required_for`     | "claim_adult_band"[] | `[]`              | Triggers that need the default provider, such as claiming the adult band. Empty means a self-declared date of birth is enough. |

## `parental`

Parental consent.

| Setting                     | Type     | Default | Description                                                                                                                                                                               |
| --------------------------- | -------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parental`                  | object   | `{}`    | Parental consent.                                                                                                                                                                         |
| `parental.consent_age`      | integer  | `13`    | Users younger than this need a parent or guardian to approve their account. (1–18)                                                                                                        |
| `parental.pending_ttl`      | duration | `"14d"` | How long an unapproved child account waits for a parent or guardian. After this the account is deleted. Written as <integer><unit> (ms, s, m, h, d, w).                                   |
| `parental.max_guardians`    | integer  | `2`     | How many parents or guardians a child account can have. (1–8)                                                                                                                             |
| `parental.graduation_grace` | duration | `"30d"` | How long parental controls stay in place after the young person reaches consent_age. After this they can ask to remove the guardian link. Written as <integer><unit> (ms, s, m, h, d, w). |

## `usernames`

Usernames.

| Setting                       | Type     | Default          | Description                                                                                                                                  |
| ----------------------------- | -------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `usernames`                   | object   | `{}`             | Usernames.                                                                                                                                   |
| `usernames.min_length`        | integer  | `8`              | Shortest a username can be. (1–64)                                                                                                           |
| `usernames.max_length`        | integer  | `18`             | Longest a username can be. (1–64)                                                                                                            |
| `usernames.charset`           | string   | `"[A-Za-z0-9_]"` | Allowed characters as a regex character class, e.g. [A-Za-z0-9_].                                                                            |
| `usernames.reserved`          | string[] | `[]`             | Usernames nobody can claim. Compared without regard to case. Empty by default.                                                               |
| `usernames.reserved_prefixes` | string[] | `[]`             | Username prefixes nobody can claim, such as a brand prefix. Compared without regard to case. Empty by default.                               |
| `usernames.change_cooldown`   | duration | `"30d"`          | How long a user must wait after claiming or changing a username before changing it again. Written as <integer><unit> (ms, s, m, h, d, w).    |
| `usernames.changes_per_year`  | integer  | `3`              | How many times a user can change their username inside change_window, after the first claim. (0–9007199254740991)                            |
| `usernames.change_window`     | duration | `"365d"`         | Window used to count username changes against changes_per_year. Written as <integer><unit> (ms, s, m, h, d, w).                              |
| `usernames.release_hold`      | duration | `"90d"`          | How long a released username is held for the previous owner before anyone else can claim it. Written as <integer><unit> (ms, s, m, h, d, w). |

## `legal`

Legal documents and re-acceptance.

| Setting                | Type    | Default   | Description                                                                                                                                |
| ---------------------- | ------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `legal`                | object  | `{}`      | Legal documents and re-acceptance.                                                                                                         |
| `legal.public_history` | boolean | `true`    | Previous versions are publicly viewable at /legal/<id>/<version>.                                                                          |
| `legal.documents_dir`  | string  | `"legal"` | Markdown documents with YAML front-matter, relative to the config file. Identity syncs them into the database on startup. (≥ 1 characters) |

## `oidc`

OIDC provider: keys, token lifetimes, scopes and seeded clients.

| Setting                                      | Type                | Default   | Description                                                                                                                                     |
| -------------------------------------------- | ------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `oidc`                                       | object              | `{}`      | OIDC provider: keys, token lifetimes, scopes and seeded clients.                                                                                |
| `oidc.issuer`                                | string \| null      | `null`    | Issuer URL advertised in discovery and used as JWT iss. null uses the api surface origin.                                                       |
| `oidc.resource`                              | string \| null      | `null`    | Access token audience (RFC 9068). null uses the issuer. Gateway oauth routes require this audience.                                             |
| `oidc.signing`                               | object              | `{}`      | Signing keys for ID tokens, access tokens and logout tokens.                                                                                    |
| `oidc.signing.algorithm`                     | "ES256" \| "RS256"  | `"ES256"` | ID and access token signing algorithm. RS256 or ES256.                                                                                          |
| `oidc.signing.encryption_key`                | string              | `""`      | Base64 32-byte key that encrypts the signing keys at rest. Required to start oidc. Reference a secret.                                          |
| `oidc.signing.rotate_after`                  | duration            | `"90d"`   | Replace the signing key once it is this old. Written as <integer><unit> (ms, s, m, h, d, w).                                                    |
| `oidc.signing.retain_after_rotation`         | duration            | `"1h"`    | Keep publishing a replaced key for this long, so tokens it signed can still be checked. Written as <integer><unit> (ms, s, m, h, d, w).         |
| `oidc.signing.refresh`                       | duration            | `"30s"`   | Reload signing keys from the store this often, so other oidc replicas pick up a rotation. Written as <integer><unit> (ms, s, m, h, d, w).       |
| `oidc.authorization_code_ttl`                | duration            | `"1m"`    | How long an authorization code can be exchanged. Written as <integer><unit> (ms, s, m, h, d, w).                                                |
| `oidc.access_ttl`                            | duration            | `"15m"`   | Access token lifetime. Written as <integer><unit> (ms, s, m, h, d, w).                                                                          |
| `oidc.id_ttl`                                | duration            | `"15m"`   | ID token lifetime. Written as <integer><unit> (ms, s, m, h, d, w).                                                                              |
| `oidc.refresh_ttl`                           | duration            | `"30d"`   | Refresh token lifetime. Rotated on every use. Written as <integer><unit> (ms, s, m, h, d, w).                                                   |
| `oidc.device_code_ttl`                       | duration            | `"15m"`   | How long a device-flow code can be approved and exchanged. Written as <integer><unit> (ms, s, m, h, d, w).                                      |
| `oidc.device_interval`                       | duration            | `"5s"`    | Minimum time a device-flow client must wait between token polls. Written as <integer><unit> (ms, s, m, h, d, w).                                |
| `oidc.pushed_authorization_ttl`              | duration            | `"1m"`    | How long a pushed authorization request_uri can be used at the authorize endpoint. Written as <integer><unit> (ms, s, m, h, d, w).              |
| `oidc.logout`                                | object              | `{}`      | Back-channel logout delivery.                                                                                                                   |
| `oidc.logout.timeout`                        | duration            | `"10s"`   | Give up on a back-channel logout POST when the client is quiet for this long. Written as <integer><unit> (ms, s, m, h, d, w).                   |
| `oidc.logout.retry_window`                   | duration            | `"24h"`   | Keep retrying a failed back-channel logout delivery for this long, then mark it failed. Written as <integer><unit> (ms, s, m, h, d, w).         |
| `oidc.logout.retry_delay`                    | duration            | `"1m"`    | Delay before the first back-channel logout retry. Doubles with each attempt. Written as <integer><unit> (ms, s, m, h, d, w).                    |
| `oidc.logout.max_retry_delay`                | duration            | `"1h"`    | Longest delay between back-channel logout retries. Written as <integer><unit> (ms, s, m, h, d, w).                                              |
| `oidc.logout.allow_private_targets`          | boolean             | `false`   | Allow logout URIs whose DNS resolves to private, loopback or link-local addresses. Loopback http URIs on 127.0.0.1 or [::1] are always allowed. |
| `oidc.developer_portal`                      | object              | `{}`      | Developer portal limits.                                                                                                                        |
| `oidc.developer_portal.max_clients_per_user` | integer             | `10`      | How many OAuth clients a user may register. (1–1000)                                                                                            |
| `oidc.scopes`                                | map<string, object> | `{}`      | Scopes and the claims they release. Built-in scopes stay unless you replace them. Add extra scopes here.                                        |
| `oidc.clients`                               | map<string, object> | `{}`      | Clients to seed on startup, keyed by client_id. Existing client_ids are left as they are; manage them in the developer portal after that.       |

## `games`

Games module (games profile): catalog, products, entitlements and keys.

| Setting                                         | Type                          | Default                             | Description                                                                                                                                                  |
| ----------------------------------------------- | ----------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `games`                                         | object                        | `{}`                                | Games module (games profile): catalog, products, entitlements and keys.                                                                                      |
| `games.default_lease_duration`                  | duration                      | `"20d"`                             | Default offline-play lease duration for a game that does not set its own. Written as <integer><unit> (ms, s, m, h, d, w).                                    |
| `games.default_cloud_save_quota_bytes`          | integer                       | `104857600`                         | Default cloud-save quota per user per game, in bytes. (0–1099511627776)                                                                                      |
| `games.server_client_name_suffix`               | string                        | `"server"`                          | Suffix used to name a game server client, joined to the game name with a space. Kept short so the full client name stays within the limit. (1–80 characters) |
| `games.keys`                                    | object                        | `{}`                                | Key redemption defaults and limits.                                                                                                                          |
| `games.keys.charset`                            | string                        | `"ABCDEFGHJKMNPQRSTUVWXYZ23456789"` | Characters used to generate keys. Distinct, no whitespace. The default is Crockford-flavoured, without letters that look like digits.                        |
| `games.keys.group_length`                       | integer                       | `4`                                 | Number of characters per hyphen-separated group. (3–12)                                                                                                      |
| `games.keys.groups`                             | integer                       | `4`                                 | Number of groups per key. (2–8)                                                                                                                              |
| `games.keys.max_batch`                          | integer                       | `10000`                             | Largest batch that can be generated in one call. (1–1000000)                                                                                                 |
| `games.licensing`                               | object                        | `{}`                                | Offline licensing: signed leases proving ownership for offline play.                                                                                         |
| `games.licensing.signing`                       | object                        | `{}`                                | Dedicated signing keys for offline licensing leases, separate from the OIDC key set.                                                                         |
| `games.licensing.signing.algorithm`             | "EdDSA" \| "ES256" \| "RS256" | `"EdDSA"`                           | Lease signing algorithm. EdDSA is smallest and fastest for offline verification.                                                                             |
| `games.licensing.signing.rotate_after`          | duration                      | `"90d"`                             | Replace the licensing signing key once it is this old. Written as <integer><unit> (ms, s, m, h, d, w).                                                       |
| `games.licensing.signing.retain_after_rotation` | duration                      | `"30d"`                             | Keep publishing a replaced licensing key for this long, so leases it signed can still be checked offline. Written as <integer><unit> (ms, s, m, h, d, w).    |
| `games.licensing.signing.refresh`               | duration                      | `"30s"`                             | Reload licensing keys from the store this often, so other games replicas pick up a rotation. Written as <integer><unit> (ms, s, m, h, d, w).                 |
| `games.licensing.max_devices`                   | integer                       | `5`                                 | How many devices a user may bind concurrently per game when device binding is on. (1–1000)                                                                   |
| `games.licensing.revocation_list_ttl`           | duration                      | `"5m"`                              | How long a signed revocation list is fresh for. Clients may cache it for this long. Written as <integer><unit> (ms, s, m, h, d, w).                          |
| `games.cloud_saves`                             | object                        | `{}`                                | Cloud saves: per-slot version history with base_version conflict detection, backed by object storage.                                                        |
| `games.cloud_saves.max_slots_per_game`          | integer                       | `20`                                | How many named save slots a user may keep per game. (1–1000)                                                                                                 |
| `games.cloud_saves.versions_per_slot`           | integer                       | `5`                                 | How many past versions to keep per slot. Older versions are pruned after a successful commit. (1–50)                                                         |
| `games.cloud_saves.max_object_bytes`            | integer                       | `52428800`                          | Largest allowed size for a single save version, in bytes. (1–1073741824)                                                                                     |
| `games.cloud_saves.upload_ttl`                  | duration                      | `"10m"`                             | How long a presigned upload URL is valid for. Uploads not committed within this window are cleaned up. Written as <integer><unit> (ms, s, m, h, d, w).       |
| `games.cloud_saves.download_ttl`                | duration                      | `"10m"`                             | How long a presigned download URL is valid for. Written as <integer><unit> (ms, s, m, h, d, w).                                                              |
| `games.steam`                                   | object                        | `{}`                                | Steam integration: ticket authentication, ownership sync and browserless sign-in for linked players.                                                         |
| `games.steam.publisher_key`                     | string                        | `""`                                | Steamworks publisher Web API key. Required when Steam is enabled. Reference a secret.                                                                        |
| `games.steam.web_api_host`                      | string                        | `"partner.steam-api.com"`           | Host that serves the Steamworks partner Web API. Ticket authentication and ownership checks go here. (≥ 1 characters)                                        |
| `games.steam.request_timeout`                   | duration                      | `"5s"`                              | Deadline for a single Steam Web API call. Written as <integer><unit> (ms, s, m, h, d, w).                                                                    |
| `games.steam.unlink_cooldown`                   | duration                      | `"7d"`                              | Once a Steam account is unlinked, the same SteamID64 cannot be linked to any account for this long. Written as <integer><unit> (ms, s, m, h, d, w).          |
| `games.steam.apps`                              | object[]                      | `[]`                                | Steam AppIDs this deployment recognises.                                                                                                                     |

## `safety`

Safety module (safety profile): reporting, moderation, CSEA workflow.

| Setting                               | Type                                    | Default                            | Description                                                                                                                                                                         |
| ------------------------------------- | --------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `safety`                              | object                                  | `{}`                               | Safety module (safety profile): reporting, moderation, CSEA workflow.                                                                                                               |
| `safety.reports`                      | object                                  | `{}`                               | Reporting behaviour.                                                                                                                                                                |
| `safety.reports.reporter_ack`         | boolean                                 | `true`                             | Email the reporter to acknowledge receipt when they gave an email address.                                                                                                          |
| `safety.reports.reporter_outcome`     | boolean                                 | `true`                             | Email the reporter with the outcome once a moderator acts on the report. Reporters are never identified to the reported user.                                                       |
| `safety.reports.default_priority`     | "low" \| "normal" \| "high" \| "urgent" | `"normal"`                         | Priority when a type's default_priority is not overridden.                                                                                                                          |
| `safety.reports.max_note_length`      | integer                                 | `2000`                             | Longest note a reporter can attach to a report. (1–2000)                                                                                                                            |
| `safety.reports.max_snapshot_bytes`   | integer                                 | `65536`                            | Longest content snapshot, in bytes, accepted on intake. (1–65536)                                                                                                                   |
| `safety.reports.sla_check_interval`   | duration                                | `"1m"`                             | How often the SLA sweep runs. sla_breached events are emitted at most once per report. Written as <integer><unit> (ms, s, m, h, d, w).                                              |
| `safety.taxonomy`                     | object                                  | `{}`                               | Report taxonomy: types, subtypes, priorities, SLAs and CSEA flags.                                                                                                                  |
| `safety.taxonomy.types`               | map<string, object>                     |                                    | Report types. Ids you set replace the built-in type of the same name, and other built-in types stay as they are.                                                                    |
| `safety.csea_alert_emails`            | string[]                                | `[]`                               | Recipients of the alert-only notification that a CSEA case exists. Bodies never contain case content.                                                                               |
| `safety.csea`                         | object                                  | `{}`                               | CSEA / NCA reporting workflow (SI 2026/268).                                                                                                                                        |
| `safety.csea.encryption_key`          | string                                  | `""`                               | Base64 32-byte key that encrypts CSEA evidence at rest. Required when CSEA is enabled. Reference a secret.                                                                          |
| `safety.csea.nca_portal_url`          | string                                  | `""`                               | URL of the NCA CSEA-IRP portal, shown to staff as the submission destination. Empty until the operator registers.                                                                   |
| `safety.csea.protective_lock`         | duration                                | `"7d"`                             | How long a one-click protective lock lasts. Staff can lift it earlier. Written as <integer><unit> (ms, s, m, h, d, w).                                                              |
| `safety.csea.priority_1`              | duration                                | `"15m"`                            | NCA submission window for priority 1 (immediate threat to a child's life or serious harm). SI 2026/268 says immediately. Written as <integer><unit> (ms, s, m, h, d, w).            |
| `safety.csea.priority_2`              | duration                                | `"4h"`                             | NCA submission window for priority 2 (risk of serious harm in the near future). SI 2026/268 says as soon as reasonably practicable. Written as <integer><unit> (ms, s, m, h, d, w). |
| `safety.csea.priority_3`              | duration                                | `"24h"`                            | NCA submission window for priority 3. SI 2026/268 says without undue delay. Written as <integer><unit> (ms, s, m, h, d, w).                                                         |
| `safety.accountable_person`           | object                                  | `{}`                               | Accountable person for the OSA safety duties (ICU A2).                                                                                                                              |
| `safety.accountable_person.name`      | string                                  | `""`                               | Name of the person accountable for compliance with the OSA safety duties. (≤ 120 characters)                                                                                        |
| `safety.accountable_person.role`      | string                                  | `""`                               | Their role, shown to legal document templates and in the admin UI. (≤ 120 characters)                                                                                               |
| `safety.actions`                      | object                                  | `{}`                               | Config-defined moderation actions and whether each is available to staff.                                                                                                           |
| `safety.actions.types`                | map<string, object>                     | `{}`                               | Moderation actions. Ids you set replace the built-in action of the same name, and other built-in actions stay as they are.                                                          |
| `safety.rules`                        | object                                  | `{}`                               | Rules offered when applying an enforcement action.                                                                                                                                  |
| `safety.rules.items`                  | map<string, object>                     | `{}`                               | Rules staff must choose from for a statement of reasons. Ids you set replace the built-in rule of the same name.                                                                    |
| `safety.restrictions`                 | string[]                                | `["chat","ugc","username_change"]` | Named restrictions a restrict action may apply, such as chat, ugc and username_change. Exposed on the identity token.                                                               |
| `safety.bans`                         | object                                  | `{}`                               | Ban policy.                                                                                                                                                                         |
| `safety.bans.require_second_approval` | boolean                                 | `false`                            | Permanent bans and proscribed-organisation removals need a second, different moderator to take effect.                                                                              |
| `safety.appeals`                      | object                                  | `{}`                               | Appeals against locks, bans and restrictions.                                                                                                                                       |
| `safety.appeals.max_length`           | integer                                 | `2000`                             | Longest appeal a user can submit. (1–2000)                                                                                                                                          |

## `support`

Support module (support profile): tickets and knowledge base.

| Setting                           | Type                | Default  | Description                                                                                                                                                           |
| --------------------------------- | ------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `support`                         | object              | `{}`     | Support module (support profile): tickets and knowledge base.                                                                                                         |
| `support.auto_close_after`        | duration            | `"7d"`   | Close tickets waiting on the user after this long. A reminder is sent at the halfway point. Written as <integer><unit> (ms, s, m, h, d, w).                           |
| `support.max_subject_length`      | integer             | `200`    | Longest ticket subject. (1–200)                                                                                                                                       |
| `support.max_body_length`         | integer             | `8000`   | Longest ticket body, reply or internal note. (1–8000)                                                                                                                 |
| `support.guest_code_ttl`          | duration            | `"15m"`  | An emailed guest-ticket code works for this long. A newer code replaces an unused one. Written as <integer><unit> (ms, s, m, h, d, w).                                |
| `support.guest_link_ttl`          | duration            | `"7d"`   | A guest magic link works for this long. Later emails send a new link, and older links keep working until they expire. Written as <integer><unit> (ms, s, m, h, d, w). |
| `support.attachment_max_bytes`    | integer             | `524288` | Largest ticket attachment, in bytes. The upload is base64 in JSON, so gateway.http.max_body_size must be about a third larger than this. (1–50000000)                 |
| `support.attachment_download_ttl` | duration            | `"15m"`  | A signed attachment download link works for this long. Downloads are sent as attachments, never displayed inline. Written as <integer><unit> (ms, s, m, h, d, w).     |
| `support.categories`              | map<string, object> | `{}`     | Ticket categories. Ids you set replace the built-in category of the same name, and other built-in categories stay as they are. Exactly one must have appeal: true.    |

## `rate_limits`

Named rate-limit policies, referenced by routes. Policies you set replace the built-in policy of the same name.

| Setting       | Type                          | Default | Description                                                                                                     |
| ------------- | ----------------------------- | ------- | --------------------------------------------------------------------------------------------------------------- |
| `rate_limits` | map<string, object \| object> |         | Named rate-limit policies, referenced by routes. Policies you set replace the built-in policy of the same name. |

## `scheduler`

Scheduler: publishes cron ticks for the services that own each job.

| Setting              | Type                | Default | Description                                                                                                                                       |
| -------------------- | ------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scheduler`          | object              | `{}`    | Scheduler: publishes cron ticks for the services that own each job.                                                                               |
| `scheduler.timezone` | string              | `"UTC"` | Time zone the job schedules are written in.                                                                                                       |
| `scheduler.jobs`     | map<string, object> | `{}`    | Jobs published on qtiauth.sys.cron.<job>. Settings you give override the built-in job of the same name, and other built-in jobs stay as they are. |

## `retention`

How long data is kept. retention.sweep deletes anything older.

| Setting                             | Type     | Default   | Description                                                                                                                                                                                          |
| ----------------------------------- | -------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `retention`                         | object   | `{}`      | How long data is kept. retention.sweep deletes anything older.                                                                                                                                       |
| `retention.delivery_logs`           | duration | `"30d"`   | Keep email, webhook and back-channel logout delivery log entries for this long. Written as <integer><unit> (ms, s, m, h, d, w).                                                                      |
| `retention.sessions`                | duration | `"30d"`   | Keep sessions and their bindings for this long after they expire or are revoked. Written as <integer><unit> (ms, s, m, h, d, w).                                                                     |
| `retention.tokens`                  | duration | `"24h"`   | Keep magic-link and other emailed tokens for this long after they expire. Written as <integer><unit> (ms, s, m, h, d, w).                                                                            |
| `retention.session_security_events` | duration | `"90d"`   | Keep session security event log rows for this long. Written as <integer><unit> (ms, s, m, h, d, w).                                                                                                  |
| `retention.filter_decisions`        | duration | `"30d"`   | Keep text-filter decisions, including the raw input, for this long. Written as <integer><unit> (ms, s, m, h, d, w).                                                                                  |
| `retention.audit`                   | duration | `"730d"`  | Keep audit log rows for this long. Oldest rows are removed first. Written as <integer><unit> (ms, s, m, h, d, w).                                                                                    |
| `retention.oauth`                   | duration | `"30d"`   | Keep expired or revoked OAuth authorization codes, access tokens and refresh tokens for this long. Written as <integer><unit> (ms, s, m, h, d, w).                                                   |
| `retention.safety_reports`          | duration | `"730d"`  | Keep closed safety reports and their snapshots for this long. Open reports and reports under a legal hold are not swept. Written as <integer><unit> (ms, s, m, h, d, w).                             |
| `retention.closed_tickets`          | duration | `"730d"`  | Keep closed support tickets, messages and notes for this long after closing. Open tickets are not swept. Written as <integer><unit> (ms, s, m, h, d, w).                                             |
| `retention.csea_evidence`           | duration | `"365d"`  | Keep encrypted CSEA evidence this long after the NCA report is sent, then destroy it with an audit record. SI 2026/268 regulation 8(1)(b): one year. Written as <integer><unit> (ms, s, m, h, d, w). |
| `retention.csea_nca_reference`      | duration | `"1825d"` | Keep the NCA unique report reference this long after submission. SI 2026/268 regulation 8(1)(a): five years (365 × 5 days). Written as <integer><unit> (ms, s, m, h, d, w).                          |

## `storage`

S3-compatible object storage.

| Setting                    | Type           | Default       | Description                                                                                                                                                                |
| -------------------------- | -------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage`                  | object         | `{}`          | S3-compatible object storage.                                                                                                                                              |
| `storage.enabled`          | boolean        | `false`       | Use S3-compatible object storage (the bundled MinIO or any external S3/R2/B2). Required for data exports above export_email_max_bytes, ticket attachments and cloud saves. |
| `storage.endpoint`         | string         | `""`          | S3 API base URL, such as http://minio:9000 or https://s3.amazonaws.com. Empty when storage is off.                                                                         |
| `storage.region`           | string         | `"us-east-1"` | S3 region. MinIO accepts us-east-1. (≥ 1 characters)                                                                                                                       |
| `storage.bucket`           | string         | `"qtiauth"`   | Bucket for exports, attachments, cloud saves and the deletion ledger. (≥ 1 characters)                                                                                     |
| `storage.access_key`       | string         | `""`          | S3 access key. Empty when storage is off. Reference a secret.                                                                                                              |
| `storage.secret_key`       | string         | `""`          | S3 secret key. Empty when storage is off. Reference a secret.                                                                                                              |
| `storage.force_path_style` | boolean        | `true`        | Path-style URLs (bucket in the path). Required for MinIO. Set false for AWS S3.                                                                                            |
| `storage.create_bucket`    | boolean        | `true`        | Create the bucket on startup if it does not exist. Turn off for Amazon S3.                                                                                                 |
| `storage.tls`              | object         | `{}`          | TLS to the S3 endpoint.                                                                                                                                                    |
| `storage.tls.ca_file`      | string \| null | `null`        | CA certificate file for verifying the server. null uses the system CAs.                                                                                                    |
| `storage.presign_expires`  | duration       | `"15m"`       | How long a presigned upload or download URL works, other than data-export links which use accounts.export_ttl. Written as <integer><unit> (ms, s, m, h, d, w).             |

## `backups`

Encrypted backups and the deletion ledger destination.

| Setting                    | Type                     | Default                      | Description                                                                                                                                                                    |
| -------------------------- | ------------------------ | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `backups`                  | object                   | `{}`                         | Encrypted backups and the deletion ledger destination.                                                                                                                         |
| `backups.destination`      | "directory" \| "storage" | `"directory"`                | Where backups and the deletion ledger are written. directory is a mounted volume. storage is the S3 bucket.                                                                    |
| `backups.directory`        | string                   | `"/var/lib/qtiauth/backups"` | Directory for backups and the deletion ledger when destination is directory. (≥ 1 characters)                                                                                  |
| `backups.retention`        | duration                 | `"35d"`                      | How long backups are kept. The deletion ledger is kept this long plus 30 days. Written as <integer><unit> (ms, s, m, h, d, w).                                                 |
| `backups.encryption_key`   | string                   | `""`                         | Base64-encoded 32-byte key that encrypts backups. Empty disables the backup service. Reference a secret. Keep a copy outside the stack: backups cannot be restored without it. |
| `backups.admin_user`       | string                   | `"postgres"`                 | Postgres role used to read every schema for pg_dump and to create the scratch database. (≥ 1 characters)                                                                       |
| `backups.admin_password`   | string                   | `""`                         | Password for backups.admin_user. Reference a secret. Empty disables backups.                                                                                                   |
| `backups.pg_dump`          | string                   | `"pg_dump"`                  | pg_dump binary the backup service invokes. Path or command on PATH. (≥ 1 characters)                                                                                           |
| `backups.pg_restore`       | string                   | `"pg_restore"`               | pg_restore binary the restore command invokes. (≥ 1 characters)                                                                                                                |
| `backups.psql`             | string                   | `"psql"`                     | psql binary used for maintenance mode and scratch-database restore. (≥ 1 characters)                                                                                           |
| `backups.scratch_database` | string                   | `"qtiauth_scratch"`          | Database name qtiauth backup verify creates for the integrity check. (≥ 1 characters)                                                                                          |
| `backups.dump_timeout`     | duration                 | `"1h"`                       | How long each schema dump may run before it is killed. Written as <integer><unit> (ms, s, m, h, d, w).                                                                         |
| `backups.chunk_size`       | integer                  | `1048576`                    | Bytes of dump plaintext per AES-GCM chunk. Larger uses less overhead, smaller lowers peak memory. (65536–16777216)                                                             |
