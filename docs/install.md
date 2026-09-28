# Install

This is the step-by-step for a fresh install. Once the stack is up, [deployment.md](deployment.md) covers day-to-day Compose commands and volumes, and [configuration.md](configuration.md) covers how config is loaded and validated.

## What you need

- A Linux host with Docker and Compose. Two CPUs and 4 GiB of RAM are enough for a small install.
- A checkout of this repository next to your `.env` and `config/` directories, or the built images if you're not building locally.
- DNS records for every hostname a surface uses, resolving to the host running the gateway.
- TLS from your own reverse proxy or the `edge` profile. QTIAuth does not terminate TLS itself.

The install is the same on a single VPS, on split hosts and across sites. What changes is which hostnames each surface answers on and whether they share a registrable domain (see [layouts](#layouts)).

## First install

```sh
cp .env.example .env
```

Fill in every required secret:

| Variable                                                                                                                                                | What it is                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `POSTGRES_PASSWORD`                                                                                                                                     | Postgres administrator, used by `qtiauth db provision`             |
| `DB_IDENTITY_PASSWORD`, `DB_NOTIFY_PASSWORD`, `DB_OIDC_PASSWORD`, `DB_SAFETY_PASSWORD`, `DB_SUPPORT_PASSWORD`, `DB_GAMES_PASSWORD`, `DB_AUDIT_PASSWORD` | One per service schema and the audit role                          |
| `KEY_ENCRYPTION_KEY`                                                                                                                                    | Envelope-encrypts signing keys. The gateway won't start without it |
| `APP_ENCRYPTION_KEY`                                                                                                                                    | Encrypts TOTP secrets and other application secrets at rest        |
| `LOG_USER_ID_HASH_KEY`                                                                                                                                  | Hashes user IDs in logs, the same on every service                 |

`.env.example` documents every other variable, and secrets and references are covered in [configuration.md](configuration.md#secrets). Generate random values with `openssl rand -base64 32`. Any variable a disabled feature references may be empty.

Copy the shipped config and change the hostnames:

```sh
cp config/qtiauth.yaml config/qtiauth.yaml.local
```

Edit `surfaces.<name>.hosts` for each surface you want, and `cookies.name` and `cookies.domain` if you don't want the defaults. `branding.product_name`, `branding.company_name` and `branding.support_email` are the values users see. Point services at your file with `QTIAUTH_CONFIG=/srv/app/config/qtiauth.yaml.local` if you kept the original in place, or replace it outright.

Provision the Postgres roles and start the stack:

```sh
docker compose --env-file .env -f deploy/compose.yaml run --rm notifier qtiauth db provision
docker compose --env-file .env -f deploy/compose.yaml up -d --wait
```

`db provision` creates one role per service schema, then applies migrations on first start. `--wait` returns once Postgres, Valkey, NATS, the gateway, identity, the notifier and the scheduler report healthy.

Check the stack is up:

```sh
curl -H 'Host: <account host>' http://<gateway host>:8000/api/v1/meta/health
curl -H 'Host: <account host>' http://<gateway host>:8000/api/v1/meta/features
```

Every enabled feature whose service is running answers healthy. A feature whose service isn't running shows up as an error there, not as a broken route.

Create the first admin from the identity image and open the returned link in a browser:

```sh
docker compose --env-file .env -f deploy/compose.yaml exec identity qtiauth admin create <email>
```

The link lets one account sign up and take the `admin` role. It expires after `parental.pending_ttl`, and re-running the command replaces it.

## Profiles

Turn on optional services with `--profile` once per profile (see [deployment.md](deployment.md#profiles)):

```sh
docker compose --env-file .env -f deploy/compose.yaml \
  --profile oidc --profile safety --profile support --profile games \
  up -d --wait
```

A profile only chooses which containers run. Features inside a service are switched on in `qtiauth.yaml` under `features.<service>.<feature>`. A sub-feature whose service isn't running is reported at `GET /api/v1/meta/health`.

## Layouts

Every surface answers on one or more hostnames and one base path. The layout is a matter of how hostnames are arranged.

### Single host

Every surface shares one hostname:

```yaml
surfaces:
  account: { hosts: [me.example.com], base_path: / }
  support: { hosts: [me.example.com], base_path: /support }
  api: { hosts: [me.example.com], base_path: /api }

cookies:
  name: qtiauth_session
  domain: null
```

Point one A/AAAA record at the gateway and terminate TLS in front of `http://<gateway>:8000`. The session cookie is `__Host-qtiauth_session`, host-only. Because every surface shares a host, signing in on one signs the user in on the others with no redirect. This is the layout in the shipped `config/qtiauth.yaml`.

### Split hosts on one registrable domain

Surfaces have different hostnames under the same registrable domain:

```yaml
surfaces:
  account: { hosts: [account.example.com], base_path: / }
  support: { hosts: [support.example.com], base_path: / }
  api: { hosts: [api.example.com], base_path: / }

cookies:
  name: qtiauth_session
  domain: example.com
```

Set `cookies.domain` to the registrable domain and the session cookie is scoped to it, so signing in on `account.example.com` signs the user in on `support.example.com` on the next request. The cookie name drops the `__Host-` prefix because `Domain=` is set; browsers still refuse it over plaintext HTTP.

### Cross-site hosts

Surfaces on different registrable domains, or on subdomains that don't share a cookie for another reason:

```yaml
surfaces:
  account: { hosts: [account.example.com], base_path: / }
  support: { hosts: [help.other.example], base_path: / }
  api: { hosts: [api.example.com], base_path: / }

cookies:
  name: qtiauth_session
  domain: null
```

The gateway can't share a cookie between hosts on different registrable domains, so each surface has its own `__Host-` cookie. Session bindings do the linking: a top-level navigation to `support` with no session redirects once to `/auth/bind` on the account surface, which sets the support cookie and sends the browser back. `/api/v1/meta/features` reports each surface pair's same-site status; a `cross_site` pair is expected here and shows up in the health page too.

Every surface must reach the gateway. If they live behind different reverse proxies, publish the gateway's port on every one and set `network.trusted_proxies` to their IPs so the client IP survives.

### Bound to ports

For host-less setups the surface answers on a port instead:

```yaml
surfaces:
  account: { ports: [8080], base_path: /, origins: ['http://10.0.0.5:8080'] }
```

Set `origins` so CORS and the `Origin` check know what browsers will send. Publish that port from the gateway container in a Compose override.

## Ports

The gateway is the only service that publishes a port on `deploy/compose.yaml`. Everything else is on the internal network and unreachable from outside the stack.

| Port          | Where                        | Purpose                                                  |
| ------------- | ---------------------------- | -------------------------------------------------------- |
| `8000`        | Gateway, `public` network    | Every surface bound to hosts                             |
| Surface port  | Gateway, `public` network    | Every surface bound to `ports` (published by you)        |
| `9090`        | Prometheus (`observability`) | Metrics UI, bound to `127.0.0.1` in the dev override     |
| `3000`        | Grafana (`observability`)    | Dashboards, bound to `127.0.0.1` in the dev override     |
| `9000`/`9001` | MinIO (`storage`)            | S3 and console, bound to `127.0.0.1` in the dev override |
| `80`/`443`    | Caddy (`edge`)               | Automatic HTTPS in front of the gateway                  |

Every service exposes `service.http.port` (default `8080`) on the internal network for `/healthz`, `/readyz` and `/metrics`. It's never published.

The dev override in `deploy/compose.dev.yaml` publishes debug ports on `127.0.0.1` for Postgres (`5432`), Valkey (`6379`) and NATS (`4222`, `8222`). Never use the dev override on a server; see [deployment.md](deployment.md#development).

## After the install

- [configuration.md](configuration.md) explains how `qtiauth.yaml` is loaded, validated and referenced from `.env`.
- [config-reference.md](config-reference.md) lists every setting with its default and description, generated from the JSON Schema.
- [runbooks](runbooks/) covers upgrades, key rotation, backup and restore, incident response, CSEA case handling and NCA registration.
- [online-safety-act.md](online-safety-act.md) maps QTIAuth to the OSA duties an operator has to run their own risk assessment against.
- [game-integration.md](game-integration.md) is the developer guide for integrating a game with the OIDC provider, entitlements, achievements, stats and leases.
