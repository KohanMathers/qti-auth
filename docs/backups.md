# Backups

The `backup` profile ships a service that runs an encrypted `pg_dump` of every
QTIAuth service schema on the `backup.run` schedule and writes the result to the
configured destination. The same image ships `qtiauth backup verify` and
`qtiauth backup restore` for operators.

## What ends up in a backup

Every archive holds:

- One `pg_dump --format=custom --schema=<schema>` blob per QTIAuth schema
  (`identity`, `notify`, `oidc`, `safety`, `support`, `games`), even if the
  profile that owns the schema is disabled at the time of the backup. Blobs are
  chunked and encrypted per chunk.
- A `storage-manifest.json` blob listing every object in the storage bucket at
  the moment the backup was taken. Restore uses it to spot objects that outlived
  the database rows that pointed at them.
- A signed manifest at the head of the archive with the archive id, database
  name, `pg_dump` version and per-schema plaintext byte counts.

Nothing in the archive is readable without `BACKUP_ENCRYPTION_KEY`. Backups are
useless without it, so keep a copy outside the stack (a password manager or a
sealed envelope) — losing the key loses every backup it protects. Ledger
entries live at the same destination and give restore the list of users to
re-erase.

## Enabling the profile

1. Generate a key and set `BACKUP_ENCRYPTION_KEY` in `.env`:

   ```sh
   openssl rand -base64 32
   ```

2. Set `POSTGRES_PASSWORD` in `.env` (the backup service uses it as
   `backups.admin_password`).
3. Bring the `backup` profile up:

   ```sh
   docker compose --profile backup up -d
   ```

The service listens for `qtiauth.sys.cron.backup.run` (default: `30 2 * * *`)
and writes archives to `backups.destination`:

- `directory` (default): a mounted volume at `backups.directory`
  (`/var/lib/qtiauth/backups` by default).
- `storage`: the `qtiauth` object-storage bucket under the `backups/` prefix.
  Requires the `storage` profile and a configured S3 endpoint.

## Retention

After each run, backups older than `backups.retention` (default 35 days) are
deleted. The newest backup is always kept, even if it is past the cutoff, so a
long-idle deployment never ends up with nothing.

The deletion ledger uses the same destination and is kept for the backup
retention plus 30 days, so every backup that could contain a listed user
expires before its ledger entry does.

## Verifying a backup

`qtiauth backup verify <archive-id>` decrypts the archive, creates the scratch
database named by `backups.scratch_database` (default `qtiauth_scratch`) and
restores each schema into it with `pg_restore --single-transaction`. The
scratch database is dropped whether verification succeeds or fails. The live
stack is not touched.

```sh
docker compose --profile backup run --rm backup \
  qtiauth backup verify 2026-09-28T02-30-00-000Z
```

Verify a backup at least monthly in a staging environment. A backup that never
restored is a backup that might not restore.

## Restoring a backup

`qtiauth backup restore <archive-id>` is a disaster-recovery command. It:

1. Drops each service schema present in the archive.
2. Restores every schema from the archive into the live database.
3. Replays the deletion ledger over the restored data, re-erasing every user
   whose ledger entry post-dates the backup. Pass `--skip-ledger-replay` only
   when the ledger is unavailable and you have accepted the risk of restoring
   a deleted user's data.
4. Revokes every restored session and binding, so the pre-restore users have
   to sign in again.

Migrations are not applied by the restore command. They run again on each
service's next startup, so bring the stack down first and rebuild it up from
the restored state:

```sh
docker compose down
docker compose --profile backup run --rm backup \
  qtiauth backup restore 2026-09-28T02-30-00-000Z
docker compose up -d
```

Users signing in during a restore see the gateway's default `503`, because
downstream services are down. There is no in-band maintenance-mode flag yet;
stopping the services is how the stack is quiet during a restore.

## Metrics

The service exports:

| Metric                                          | Description                                     |
| ----------------------------------------------- | ----------------------------------------------- |
| `qtiauth_backup_runs_total{outcome}`            | Successful and failed backup runs.              |
| `qtiauth_backup_duration_seconds`               | Backup duration histogram.                      |
| `qtiauth_backup_size_bytes`                     | Bytes of the most recent backup.                |
| `qtiauth_backup_storage_objects`                | Objects captured in the last backup's manifest. |
| `qtiauth_backup_retained`                       | Backups the last retention sweep kept.          |
| `qtiauth_backup_deleted_total`                  | Backups deleted by retention.                   |
| `qtiauth_backup_last_success_timestamp_seconds` | Unix time of the last successful run.           |

Alert on `qtiauth_backup_last_success_timestamp_seconds` staying more than one
day behind now, and on any tick of `qtiauth_backup_runs_total{outcome="failed"}`.

## Config reference

```yaml
backups:
  destination: directory
  directory: /var/lib/qtiauth/backups
  retention: 35d
  encryption_key: '${env:BACKUP_ENCRYPTION_KEY}'
  admin_user: postgres
  admin_password: '${env:POSTGRES_PASSWORD}'
  pg_dump: pg_dump
  pg_restore: pg_restore
  psql: psql
  scratch_database: qtiauth_scratch
  dump_timeout: 1h
  chunk_size: 1048576
```
