# Threat model: backup

The backup service runs an encrypted `pg_dump` of every schema on the `backup.run` schedule and writes to the configured destination. The same image ships `qtiauth backup verify` and `qtiauth backup restore`. See [../backups.md](../backups.md) for the working model.

## Assets

- **Backup archives.** Contain every schema's contents. Useless without the key, but everything is in there.
- **The backup encryption key** (`BACKUP_ENCRYPTION_KEY`). Loss of the key loses every backup that used it.
- **The deletion ledger.** Restore replays it to re-erase users deleted after the backup.
- **Restore artefacts** (scratch database, replayed events).

## Trust boundaries

- **Scheduler → backup.** Cron tick over the internal bus.
- **Backup → Postgres.** Uses `POSTGRES_PASSWORD` (admin) to `pg_dump` every schema.
- **Backup → destination** (directory or object storage).

## Threats

- **Key theft.** Backups are useless without the key. Operators must keep a copy of the key outside the stack; the runbook says so.
- **Restore of a maliciously modified backup.** Manifest is signed by the backup writer; `qtiauth backup verify` walks the archive and refuses on a mismatch. Restore fails closed on a manifest mismatch.
- **Restore of an old, revoked-session backup.** `qtiauth backup restore` revokes all restored sessions and bindings after the schema restore.
- **Replay of a deleted user.** `qtiauth backup restore` replays the deletion ledger and re-erases every listed user found in the restored data, including their stored objects.
- **Sensitive data in scratch verification.** `qtiauth backup verify` restores into a scratch database that lives only for the verify duration and is dropped afterwards.
- **Retention drift.** `backups.retention` is enforced by the sweeper; a restore that runs an old dump loses more recent history but never re-introduces already-purged data thanks to the ledger replay.
- **Compromised backup destination.** The archive is still encrypted; the attacker gets ciphertext plus the archive manifest metadata.

## Mitigations

- AES-256-GCM (or equivalent, per config) with per-archive nonces.
- Non-root, read-only container. Backup destination is either an object store or a mounted volume, never egress to arbitrary hosts.
- Restore has a maintenance-mode gate: the gateway serves 503 to everything but health while it runs.

## Open questions

- Should we sign the manifest with a separate key from the encryption key, so a leaked encryption key doesn't also let an attacker forge manifests?
