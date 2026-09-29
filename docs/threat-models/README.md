# Threat models

One page per service, plus one for shared infrastructure. Each covers what the service holds, what it trusts, the threats worth naming and the mitigations already in place. They're written for reviewers and operators, and updated alongside the code.

Format:

- **Assets** — what the service holds that an attacker would want.
- **Trust boundaries** — where untrusted input enters and where privileges change.
- **Threats** — STRIDE-flavoured list of what could go wrong, most severe first.
- **Mitigations** — the code and config that block each threat, or the residual risk when a threat can't be fully blocked.
- **Open questions** — things the next review should re-check.

The threats aren't exhaustive; they're the ones worth writing down. If a finding in a security review isn't covered here, add it before shipping the fix.

| Service        | Page                         |
| -------------- | ---------------------------- |
| Gateway        | [gateway.md](gateway.md)     |
| Identity       | [identity.md](identity.md)   |
| OIDC           | [oidc.md](oidc.md)           |
| Notifier       | [notifier.md](notifier.md)   |
| Scheduler      | [scheduler.md](scheduler.md) |
| Safety         | [safety.md](safety.md)       |
| Support        | [support.md](support.md)     |
| Games          | [games.md](games.md)         |
| Backup         | [backup.md](backup.md)       |
| Infra (shared) | [infra.md](infra.md)         |
