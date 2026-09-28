---
'@qtiauth/backup': minor
'@qtiauth/config': minor
---

Add the `backup` profile: a service that runs `pg_dump` for every schema on the `backup.run` schedule, encrypts the archive with `BACKUP_ENCRYPTION_KEY` (chunked AES-256-GCM), captures a manifest of the object-storage bucket, and enforces `backups.retention` at the directory or storage destination. Ships `qtiauth backup verify` for scratch-database integrity checks and `qtiauth backup restore` for disaster recovery, which replays the deletion ledger and revokes every restored session.
