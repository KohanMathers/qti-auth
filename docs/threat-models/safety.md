# Threat model: safety

The safety service accepts user, content and machine reports, holds the
moderation queue and runs the CSEA / NCA workflow. See
[../safety.md](../safety.md) and [../compliance/csea.md](../compliance/csea.md)
for the working model and the statutory context.

## Assets

- **Reports** (user, content and machine).
- **CSEA cases** and evidence, including the NCA reference number.
- **Moderation actions and audit trail.**
- **Appeal tickets and their linkage to enforcement actions.**

## Trust boundaries

- **Gateway → safety.** Requests carry a gateway-signed identity token.
- **Game servers / classifiers → safety.** Reports over `auth: service` or
  `auth: oauth` with `safety.reports.submit` scope.
- **Safety → support (bus).** Appeals open a ticket over the bus.
- **Safety → operator NCA workflow.** Physical / procedural, not code.

## Threats

- **Report spam / DoS.** Per-user, per-IP and per-scope rate limits at the
  gateway; CAPTCHA gate on the account-UI intake at high volume.
- **Report of an innocent user (harassment).** Moderator review is required
  before any user-facing action; the audit log links every action to its
  reviewer.
- **Content leak.** Reported content is stored encrypted at rest under
  `storage.encryption_key`; access is scoped to the safety schema.
- **CSEA evidence tampering.** Evidence is written once, hashed and chained
  into the audit log. Retention meets SI 2026/268.
- **Machine-classifier compromise.** Machine reports carry a `source_id` and
  are quarantined into a review queue rather than acted on automatically.
- **PII leak in logs.** Report content is never logged; only the report ID,
  category and result.
- **Automation loop.** Safety cannot enforce on itself: a safety-issued
  ticket is a support ticket, and support decides on it.

## Mitigations

- Only bus + Postgres on the internal network.
- Non-root, read-only container.
- CSEA workflow is documented and audited; NCA registration and case IDs are
  part of the operator runbook.

## Open questions

- Do we want to add per-source-id trust levels for machine classifiers so
  higher-trust sources bypass the moderator queue for low-severity actions?
