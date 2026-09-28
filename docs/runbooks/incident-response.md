# Incident response

Playbook for a suspected compromise, a staff account takeover or a credential leak. It's short on purpose. For CSEA cases see [csea-case-handling.md](csea-case-handling.md); those are handled through the Safety UI, not this runbook.

The `accountable_person` in `safety.accountable_person` is the person the response reports to (ICU A2). Every step here is auditable and shows up in `qtiauth audit verify`.

## Declare

At the start of every incident, note the time and the trigger in the operator log. If it's a credential leak, get the exact credential out of any chat channel that isn't the operator log before you do anything else.

Severity is set by the accountable person, not by whoever declared it. As a rule of thumb:

- **P1**: production data may have left the stack, or the stack is down for more than 15 minutes.
- **P2**: a staff account is compromised, or a single user's data was exposed to one other user.
- **P3**: everything else that needs investigating but is contained.

## Contain

Do only what's needed to stop the bleeding, and record every action so it can be undone later.

### Suspected staff account compromise

1. Revoke every session for the account:
   ```sh
   POST /api/v1/admin/users/<user_id>/sessions/revoke-all
   ```
   with a step-up session under `users.manage`.
2. Lock the account with an expiry longer than the investigation window:
   ```
   POST /api/v1/admin/users/<user_id>/lock  { "until": "<iso>", "reason": "incident <id>" }
   ```
3. Force a username reset and force re-auth on unlock.
4. Rotate the account's roles: remove privileged roles until the investigation clears them.
5. If they held `safety.csea.access` or any other permission not covered by wildcards, ask a second admin to confirm the revocation was applied.

### Suspected credential leak (a signing key or `.env` value)

1. If `KEY_ENCRYPTION_KEY` may be compromised: follow [key-rotation.md](key-rotation.md#rotate-key_encryption_key) to add a new key alongside, then publish a `keys.rotate` tick to re-wrap the stored keys, then remove the old key from `.env`.
2. If a signing key (gateway internal identity, oidc, licensing) may be compromised: shorten the relevant `retain_after_rotation`, publish `keys.rotate` from NATS to rotate immediately, then restore the value.
3. If `BACKUP_ENCRYPTION_KEY` may be compromised: generate a new key, take a new backup encrypted with it, verify it (see [backup-restore.md](backup-restore.md#verify-a-backup)), and destroy every older backup at the destination.
4. If a Postgres role password may be compromised: change the value in `.env`, then `docker compose run --rm notifier qtiauth db provision` to re-apply, then restart the affected service.
5. If a social provider client secret is compromised: rotate the secret at the provider, update `.env`, restart identity.

### Suspected data exfiltration through the API

1. Enable stricter rate limits on the affected route in `qtiauth.yaml` and restart the gateway.
2. If a specific OAuth client is the source, suspend it from the admin UI (`POST /api/v1/admin/oauth/clients/:client_id/suspend`); its access and refresh tokens are revoked at once (see [oidc.md](../oidc.md)).
3. Ban or lock the accounts implicated. A ban revokes their sessions and every OAuth refresh token, including `offline_access`.

## Investigate

- Every gateway request has a trace ID in the logs, and every service publishes trace IDs on the bus. Search Loki (with the observability profile) or `docker compose logs` for the trace or user ID hash.
- Identity's audit log is append-only with a hash chain. Run `qtiauth audit verify` after any incident to prove it wasn't tampered with.
- The webhooks delivery log shows every outbound event that fired.
- CSEA cases are isolated from every other log stream; investigate them through the Safety UI (see [csea-case-handling.md](csea-case-handling.md)).

Record findings in the operator log alongside the trigger time and the containment actions.

## Recover

- Undo the containment actions in reverse order once the account or key has been proven clean or replaced.
- Notify affected users through the notifier's `security` category (which no user can disable). Neither the notice nor its subject line names another user.
- If personal data left the stack, follow your data-breach reporting duty. QTIAuth doesn't decide that for you.

## Post-incident

- Write the incident up in the operator log within two working days, with the timeline, root cause and what stops it happening again.
- Add a test that catches the regression: an integration test, a metric alert, or a rate-limit rule.
- If the incident touched a section that has a runbook, update the runbook with what you learned.
