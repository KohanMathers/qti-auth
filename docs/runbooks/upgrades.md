# Upgrades and migrations

Upgrades pull new images, restart services in place and let each service apply its own pending migrations on startup. Migrations follow the expand/contract rule (see [database.md](../database.md#expandcontract)), so one image version back always works against the current schema.

## Before you start

- Read the changelog for every package or service you're pulling. Anything that needs config changes will say so in its changeset.
- Take a backup (see [backup-restore.md](backup-restore.md)) if the release lists a destructive migration, so you can restore the old schema if you need to.
- Run `pnpm qtiauth config check --env-file .env` on the new images if you can. It reports every unknown key and every unset reference, without starting anything.

## Rolling upgrade

Every service can be replaced without stopping the others. The gateway forgets an instance it hasn't heard from for `gateway.discovery.expiry` (90 s by default), so short overlaps during a restart are handled by the route table.

```sh
docker compose --env-file .env -f deploy/compose.yaml pull
docker compose --env-file .env -f deploy/compose.yaml up -d --wait
```

`--wait` returns once every replacement service is healthy. Migrations run as part of that startup: each service takes an advisory lock on its own schema and applies anything pending exactly once. Watch the log of each restarted service for `applied migration <name>` lines.

If a service has `migrations.auto_apply: false`, it refuses to start with pending migrations and prints the command to run first:

```sh
docker compose --env-file .env -f deploy/compose.yaml run --rm <service> qtiauth migrate up
```

Then bring the service up as normal.

## Verifying

Check `/api/v1/meta/health` at the gateway. Every feature should be `ok`, no route should be reported as a conflict, and every service should show its expected version.

```sh
curl -H 'Host: <account host>' http://<gateway host>:8000/api/v1/meta/health
```

Run `qtiauth audit verify` from the identity image (see [identity.md](../identity.md#audit)) to make sure the audit chain still verifies after the upgrade.

## Rolling back

Roll the image tag back and restart:

```sh
docker compose --env-file .env -f deploy/compose.yaml pull
docker compose --env-file .env -f deploy/compose.yaml up -d --wait
```

The older service reports the new migrations as `unknown` in `qtiauth migrate status`; this is expected and doesn't stop it running. Roll back only one image version at a time. Rolling back further means restoring a backup taken before the earlier upgrade (see [backup-restore.md](backup-restore.md)).

## When something goes wrong

- **A service won't start.** Look at its log. Config problems name the YAML path, line and column. A migration that failed rolls back in its own transaction, so the schema is untouched, but the service won't start until the migration is fixed and re-released.
- **A route is missing from the gateway.** `/api/v1/meta/health` reports it as a conflict, an unknown rate-limit policy, or a discovery expiry. Restart the owning service to re-announce.
- **A migration deadlocks.** The advisory lock is per schema, so only that schema's services block. Check for a long-running admin query on the same schema and cancel it.
- **A newer image needs a config key you haven't set.** The service prints the exact YAML path and exits 1 without starting. Add the key and re-run `up -d --wait`.
