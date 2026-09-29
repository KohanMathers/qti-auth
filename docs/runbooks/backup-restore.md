# Backup and restore

QTIAuth stores state in Postgres and object storage. The `backup` profile takes scheduled encrypted dumps of every service schema and a manifest of object keys, keeps them for `backups.retention` (35 d by default) and, together with the deletion ledger, lets a full stack be restored from cold storage.

`BACKUP_ENCRYPTION_KEY` is required and never sits in the same place as the backups themselves. Losing it means the backups can't be read.

## Backup destinations

| `backups.destination` | Where it writes                                    | Suitable for                                |
| --------------------- | -------------------------------------------------- | ------------------------------------------- |
| `directory`           | `backups.directory` (the `backups` compose volume) | Small installs; mirrored off-host by others |
| `storage`             | The `storage` bucket at prefix `backups/`          | Everything that already uses object storage |

Whichever destination you use, the deletion ledger writes there through an outbox as well, so a restored stack can replay every deletion that happened after the dump.

## Scheduled backups

Enable the profile:

```sh
docker compose --env-file .env -f deploy/compose.yaml --profile backup up -d --wait
```

The `backup.snapshot` cron job runs nightly at 02:00 by default and takes one dump per service schema plus a manifest of object keys under `users/` and `attachments/`. Each dump and the manifest is encrypted with `BACKUP_ENCRYPTION_KEY` and written under a per-run directory named for its UTC timestamp. `backup.prune` removes runs older than `backups.retention`.

Watch `qtiauth_backup_last_success_timestamp_seconds` on the observability dashboard, and alert if it doesn't advance within one interval.

## Verify a backup

Restore into a scratch database without touching the live stack:

```sh
docker compose --env-file .env -f deploy/compose.yaml exec identity \
  qtiauth backup verify --run <timestamp>
```

`verify` decrypts every dump and restores it into a temporary schema, then reports row counts per table. It exits 1 on any decryption or restore error. Run it monthly, or after any change that touches migrations or the backup pipeline.

## Restore

Restoration is destructive to whatever is already in Postgres. Take it as a full outage: the stack goes into maintenance, restores, replays the deletion ledger, revokes every session and binding, migrates and starts up again.

1. **Enter maintenance.** Publish `qtiauth.sys.maintenance.on`:
   ```sh
   docker compose --env-file .env -f deploy/compose.yaml exec nats \
     nats pub qtiauth.sys.maintenance.on '{}'
   ```
   Every service refuses non-`/healthz` and non-`/readyz` requests and drains outstanding work.
2. **Stop the QTIAuth services** but leave Postgres, Valkey and NATS running:
   ```sh
   docker compose --env-file .env -f deploy/compose.yaml stop \
     gateway identity notifier scheduler oidc safety support games
   ```
3. **Decrypt and restore** into Postgres from the run you want to restore:
   ```sh
   docker compose --env-file .env -f deploy/compose.yaml run --rm identity \
     qtiauth backup restore --run <timestamp>
   ```
   `restore` decrypts every dump, drops and recreates each service schema, and restores it under an advisory lock.
4. **Replay the deletion ledger.** `restore` reads `deletion-ledger/` from the same destination and applies every entry whose `deleted_at` is after the dump's timestamp, so users who were deleted after the backup are still gone.
5. **Revoke every session and binding.** `restore` publishes `identity.sessions.revoked_all` before returning, which drops caches on every future replica.
6. **Migrate.** Start the QTIAuth services back up; each one migrates its schema up to the current image on startup:
   ```sh
   docker compose --env-file .env -f deploy/compose.yaml up -d --wait
   ```
7. **Exit maintenance.** Publish `qtiauth.sys.maintenance.off`:
   ```sh
   docker compose --env-file .env -f deploy/compose.yaml exec nats \
     nats pub qtiauth.sys.maintenance.off '{}'
   ```

Once traffic is flowing again, run `qtiauth audit verify` on identity to confirm the audit chain is intact.

## Disaster-recovery drill

At least once a quarter, run the whole restore against a scratch stack:

1. Take a fresh backup.
2. Delete a test user through the account UI.
3. Wipe the Postgres volume: `docker compose down -v` on the scratch stack.
4. Restore the backup and confirm the deleted test user does not come back, every session is revoked, and `/api/v1/meta/health` reports green.

Record the drill's result and how long it took in the operator log. If restore fails, treat it as a P1 incident (see [incident-response.md](incident-response.md)), the drill's whole purpose is to find broken backups before you need them.

## Pruning the deletion ledger

The deletion ledger is kept for `backups.retention` plus 30 days (`deletion_ledger.prune`), so a restore from the oldest usable backup still has the ledger it needs. Don't lengthen the ledger's retention past what backups can reach; a ledger entry with no matching row in any live backup is dead weight.
