# Deployment

QTIAuth runs as one Docker Compose stack. The Compose files live in `deploy/`:

| File                      | Contents                                                           |
| ------------------------- | ------------------------------------------------------------------ |
| `deploy/compose.yaml`     | Postgres, Valkey, NATS and the services for each profile           |
| `deploy/compose.dev.yaml` | Development override: debug ports and the `console` email provider |

Run every command from the repository root, next to `.env` and `config/`.

## First start

```sh
cp .env.example .env
```

Fill in `.env`. `POSTGRES_PASSWORD`, `KEY_ENCRYPTION_KEY` and every `DB_*_PASSWORD` are required. Every variable is described in `.env.example`, and secrets are covered in [configuration.md](configuration.md#secrets).

Create each service's Postgres role and schema, then start the stack:

```sh
docker compose --env-file .env -f deploy/compose.yaml run --rm notifier qtiauth db provision
docker compose --env-file .env -f deploy/compose.yaml up -d --wait
```

Provisioning starts the infrastructure first and is safe to run again, for example after changing a `DB_*_PASSWORD` (see [database.md](database.md#provisioning-roles)). `--wait` returns once Postgres, Valkey, NATS, the gateway, identity, the notifier and the scheduler report healthy. QTIAuth services start only after the infrastructure is healthy.

Set `email.smtp` in `config/qtiauth.yaml` to your mail server before relying on email (see [notifier.md](notifier.md)). Until then, email waits in the queue and is retried.

The gateway, identity, notifier and scheduler are built from source the first time. Rebuild them after pulling changes with `docker compose --env-file .env -f deploy/compose.yaml build`.

## Profiles

Postgres, Valkey and NATS always run, as do the core services `gateway`, `identity`, `notifier` and `scheduler`, and `web` will once it's added. Optional services run when their profile is enabled:

| Profile         | Services                                 |
| --------------- | ---------------------------------------- |
| `oidc`          | `oidc`                                   |
| `safety`        | `safety`                                 |
| `support`       | `support`                                |
| `games`         | `games`                                  |
| `storage`       | `minio`                                  |
| `geoip`         | `geoip-updater`                          |
| `edge`          | `caddy`                                  |
| `backup`        | `backup`                                 |
| `observability` | `prometheus`, `grafana`, `tempo`, `loki` |

Enable profiles with `--profile`, once per profile:

```sh
docker compose --env-file .env -f deploy/compose.yaml --profile games --profile support up -d --wait
```

A profile only chooses which containers run. Features inside a service are switched on in `qtiauth.yaml`, and the gateway reports a feature whose service isn't running at `GET /api/v1/meta/health`.

Services that haven't been built yet run as empty placeholder containers, so every profile can already be enabled.

## Networking

Everything runs on the `internal` network, which has no route in or out of the host. Only the gateway is also on the `public` network, and only it publishes a port: `8000`, for surfaces bound to hosts (see [gateway.md](gateway.md)). Put your TLS-terminating reverse proxy in front of it, or use the `edge` profile once it's available. If you bind surfaces to their own `ports`, publish those as well.

## Data

| Volume     | Holds                                                                          |
| ---------- | ------------------------------------------------------------------------------ |
| `postgres` | The `qtiauth` database                                                         |
| `nats`     | JetStream streams and messages                                                 |
| `geoip`    | The DB-IP Lite (or MaxMind) country database, read by identity and the gateway |
| `minio`    | Object storage when the `storage` profile is enabled                           |
| `backups`  | The deletion ledger (and later, encrypted backups) at `backups.directory`      |

Valkey keeps nothing on disk. Nothing in it is a source of truth, so restarting it only clears caches and rate-limit counters.

The `geoip` profile runs `geoip-updater`, which downloads DB-IP Lite into that volume and refreshes it about once a month. Until a database is present, `GET /api/v1/meta/health` reports `GEOIP_UNAVAILABLE` and country checks switch off.

The `storage` profile runs MinIO. Set `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `S3_ACCESS_KEY` and `S3_SECRET_KEY` in `.env` (the S3 keys should match the MinIO root user when using the bundled server), then set `storage.enabled: true` and `storage.endpoint: http://minio:9000` in `qtiauth.yaml`. Identity does not wait for MinIO to start. Until storage is enabled, `GET /api/v1/meta/health` reports `STORAGE_UNAVAILABLE` and large data exports cannot be delivered.

The database is created as `qtiauth`, the default `database.name`. If you change `database.name`, create that database before running `qtiauth db provision` (see [database.md](database.md)).

## Development

The development override makes the `internal` network reachable from the host and publishes debug ports on `127.0.0.1` only:

```sh
docker compose --env-file .env -f deploy/compose.yaml -f deploy/compose.dev.yaml up -d --wait
```

In this repository, `pnpm stack:dev` runs `docker compose` with both files, e.g. `pnpm stack:dev up -d --wait` or `pnpm stack:dev logs -f nats`.

| Port   | Service                     |
| ------ | --------------------------- |
| `5432` | Postgres                    |
| `6379` | Valkey                      |
| `4222` | NATS clients                |
| `8222` | NATS monitoring (`/jsz`, …) |

QTIAuth services read `config/qtiauth.dev.yaml` instead of `config/qtiauth.yaml`. It uses the `console` email provider, so emails, including magic links, are printed to the notifier's output instead of being sent (`pnpm stack:dev logs -f notifier`), and it serves every surface on `localhost` with `http://localhost:8000` as their origin, so a browser can use the stack at <http://localhost:8000>. Everything else is left at its defaults, apart from the same secret references as the shipped config.

### Signing in

With the development stack running, sign up from the command line and finish in a browser:

```sh
curl -X POST http://localhost:8000/api/v1/auth/magic-link/start \
  -H 'content-type: application/json' -d '{"email": "you@example.com"}'
pnpm stack:dev logs notifier
```

Open the link from the notifier's output in a browser at <http://localhost:8000>, press **Continue**, enter a date of birth and you're signed in. The page links to `/api/v1/me` and `/api/v1/sessions`, and has a sign-out button. Each request's trace ID is in the gateway's and identity's logs (`pnpm stack:dev logs gateway identity`). See [identity.md](identity.md) for the rest of the API.

Never use the development override on a server. To switch an existing stack to or from it, run `down` first, since the `internal` network has to be recreated.

## Stopping

```sh
docker compose --env-file .env -f deploy/compose.yaml --profile '*' down
```

Add `--volumes` to delete the database and JetStream data as well.

---

## For developers

### Adding a service

Each QTIAuth service extends `x-qtiauth-service` in `deploy/compose.yaml`, which puts it on the `internal` network, mounts `config/`, passes `.env` and waits for healthy infra. Replace the placeholder `image` and `command` with a `build` of the service's Dockerfile and `command: ['node', 'src/main.ts']`, as `gateway`, `identity`, `notifier` and `scheduler` do. Add every QTIAuth service to `deploy/compose.dev.yaml` as `*dev-service`, so it reads the development config.

The infra images in `deploy/compose.yaml` match the images integration tests run (`IMAGES` in `@qtiauth/testing`). A unit test fails if they drift, so update both together. The same tests check that every profile has its services, that only the gateway publishes a port and that `.env.example` documents every variable the Compose files use.
