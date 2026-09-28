# Threat model: shared infrastructure

The three infra containers (`postgres`, `valkey`, `nats`) and the optional
edge and object-storage ones. See the working docs
[../database.md](../database.md), [../bus.md](../bus.md) and
[../deployment.md](../deployment.md).

## Assets

- **The database.** Every service's data lives here.
- **Valkey cache** holds session cache entries, rate-limit counters, PKCE and
  OAuth state.
- **NATS JetStream** holds domain events and cron ticks.
- **Object storage** (MinIO or external S3) holds attachments, cloud saves,
  KB images and data exports.
- **The edge proxy's** TLS private key and ACME account key (when the `edge`
  profile is on).

## Trust boundaries

- **Public → edge.** All input untrusted. TLS terminates here.
- **Edge / operator proxy → gateway.** Gateway trusts `X-Forwarded-For`
  from configured CIDRs.
- **Services ↔ infra.** Internal network only; the `internal` Docker network
  has no route in or out of the host in production.

## Threats

- **Postgres role escalation.** Each service runs with its own role, scoped
  to its schema. `db provision` refuses to grant cross-schema access.
- **Valkey command injection via user-supplied keys.** Keys are prefixed and
  sanitised; the Lua rate-limit script only accepts numeric arguments.
- **NATS subject injection.** Publishers set the subject; consumers filter
  by their subject prefix. Cross-service subjects are enforced by naming
  convention plus the outbox relay.
- **Object storage bucket takeover.** Bucket policy is set by the operator;
  MinIO's default configuration only accepts requests over the internal
  network.
- **Edge cert loss on rotate.** Caddy retries and keeps the previous cert
  until a new one succeeds; alert `EdgeCertificateExpirySoon` fires 14 days
  ahead.
- **DoS by big requests.** Gateway enforces body-size cap; the edge proxy
  additionally caps request buffer sizes.
- **Cross-container escape.** All QTIAuth services run non-root, read-only,
  no capabilities; a container escape needs a kernel bug.
- **Leaked secrets in env dumps.** `.env` is not baked into the image; env
  vars are read at boot and Docker secret files supported via `${file:...}`.

## Mitigations

- Non-root, read-only, no-caps for every QTIAuth container.
- Only gateway (or caddy on the edge profile) publishes ports.
- Internal Docker network has no external route in production.
- Compose test enforces the port and network scope; a change that publishes
  something new fails CI.

## Open questions

- Should we ship a hardened `postgresql.conf` and `valkey.conf` alongside the
  default images, or leave that to operators?
- Do we want to distribute a docker seccomp profile alongside the compose
  file?
