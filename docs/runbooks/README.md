# Runbooks

Short, checklist-style guides for the operational tasks a QTIAuth deployment runs into. Each one assumes the stack is already installed (see [install.md](../install.md)) and that you can `docker compose --env-file .env -f deploy/compose.yaml <command>` from the repository root.

| Runbook                                        | When to use it                                              |
| ---------------------------------------------- | ----------------------------------------------------------- |
| [upgrades.md](upgrades.md)                     | Pulling new images and applying migrations                  |
| [key-rotation.md](key-rotation.md)             | Rotating identity, OIDC and licensing signing keys          |
| [backup-restore.md](backup-restore.md)         | Scheduled backups, verification and disaster recovery       |
| [incident-response.md](incident-response.md)   | Suspected compromise, staff account takeover or data breach |
| [csea-case-handling.md](csea-case-handling.md) | Handling a CSEA case from open to submitted                 |
| [nca-registration.md](nca-registration.md)     | Registering the deployment operator with the NCA CSEA-IRP   |

The runbooks refer to durations and file paths under the shipped defaults. If you changed them, use your own values instead.
