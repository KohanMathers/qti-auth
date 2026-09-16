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

Fill in `.env`. `POSTGRES_PASSWORD` is required, and Compose refuses to start without it. Every variable is described in `.env.example`, and secrets are covered in [configuration.md](configuration.md#secrets).

```sh
docker compose --env-file .env -f deploy/compose.yaml up -d --wait
```

`--wait` returns once Postgres, Valkey and NATS report healthy. QTIAuth services start only after all three are healthy.

## Profiles

Postgres, Valkey and NATS always run, as will the core services (`gateway`, `identity`, `notifier`, `scheduler` and `web`) once they're added. Optional services run when their profile is enabled:

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

Everything runs on the `internal` network, which has no route in or out of the host. No service publishes a port. The gateway, or Caddy with the `edge` profile, will be the only exception.

## Data

| Volume     | Holds                          |
| ---------- | ------------------------------ |
| `postgres` | The `qtiauth` database         |
| `nats`     | JetStream streams and messages |

Valkey keeps nothing on disk. Nothing in it is a source of truth, so restarting it only clears caches and rate-limit counters.

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

QTIAuth services read `config/qtiauth.dev.yaml` instead of `config/qtiauth.yaml`. It uses the `console` email provider, so emails, including magic links, are printed to the notifier's logs instead of being sent. Everything else is left at its defaults, apart from the same secret references as the shipped config.

Never use the development override on a server. To switch an existing stack to or from it, run `down` first, since the `internal` network has to be recreated.

## Stopping

```sh
docker compose --env-file .env -f deploy/compose.yaml --profile '*' down
```

Add `--volumes` to delete the database and JetStream data as well.

---

## For developers

### Adding a service

Each QTIAuth service extends `x-qtiauth-service` in `deploy/compose.yaml`, which puts it on the `internal` network, mounts `config/`, passes `.env` and waits for healthy infra. For a profile service, replace its placeholder `image` and `command` with the service's own image. Add every QTIAuth service to `deploy/compose.dev.yaml` as `*dev-service`, so it reads the development config.

The infra images in `deploy/compose.yaml` match the images integration tests run (`IMAGES` in `@qtiauth/testing`). A unit test fails if they drift, so update both together. The same tests check that every profile has its services, that the base file publishes no ports and that `.env.example` documents every variable the Compose files use.
