# CSEA case handling

Step-by-step for staff with `safety.csea.access` from a case being opened to the NCA report being submitted. The legal parameters (report fields, timeframes and retention) sit in [compliance/csea.md](../compliance/csea.md); this runbook is only about how staff work through a case in the Safety UI.

Nothing about a CSEA case ever reaches logs, traces, metric labels, webhooks or email bodies. The only outbound notification is an alert-only mail to `safety.csea_alert_emails` saying that a case exists, with a link and nothing else.

## Before the first case

- Register the deployment operator with the NCA CSEA-IRP (see [nca-registration.md](nca-registration.md)).
- Set `safety.csea.nca_portal_url` to the portal address staff should open.
- Grant `safety.csea.access` to the trained staff by name. `*` and `safety.*` never cover it. Built-in roles do not include it.
- Confirm `safety.csea.encryption_key` is set. Safety will not start with CSEA enabled if it's missing or not 32 bytes.
- Confirm `safety.csea_alert_emails` is set. Staff outside the CSEA team never receive case content, only these alerts.

## When a case opens

A case opens when a report on a CSEA-flagged type comes in from any source (user, game intake API, automated flag) or when a moderator reclassifies an existing report. The service publishes `qtiauth.safety.csea.case_opened.v1` and mails everyone in `csea_alert_emails` with a link.

Assign yourself the case from the queue as soon as you pick it up. The queue orders open and submitted cases by NCA submission deadline. The default priority for a new case is priority 2 (4 hours to submit). Reclassify to priority 1 (15 minutes) if there is a threat to a child's life or serious harm, or priority 3 (24 hours) if the case is not urgent.

## Preserve the account

A one-click protective lock locks the account for `safety.csea.protective_lock` (7 d by default) and stops content being edited:

```
POST /api/v1/admin/safety/csea/cases/<case_id>/protect
```

The lock is audited. It doesn't remove the account, so evidence is preserved. Do this before anything else if the reported account is still live.

## Fill the Schedule 1 checklist

The case has the Schedule 1 fields grouped in the sidebar. The mapping is in [compliance/csea.md](../compliance/csea.md#report-fields-schedule-1). Prefilled fields (detection method, platform, upload time, whether content is held) come from the report. Fill everything else you can lawfully obtain: the reporting person's contact details, account identifiers, sign-in IPs, billing details when held, verification history.

Tick each field either **have value** with a value entered, or **not held** with a short note explaining why. **Not held** is not the same as blank. The submission checklist reflects the SI 2026/268 requirement; the NCA needs to know what you looked for.

Mark **declaration: true** on the reporting person's declaration only when the value in `reporting_person_name` is the person you are actually declaring for.

## Submit to the NCA

There is no NCA API. Staff copy the case details into the CSEA-IRP portal by hand, submit there, and record the outcome back on the case:

1. Open the portal at `safety.csea.nca_portal_url`.
2. Fill in the corresponding Schedule 1 fields from the checklist.
3. Attach the encrypted evidence blob the case page offers (`GET /api/v1/admin/safety/csea/cases/<case_id>/evidence` needs step-up).
4. Submit and note the unique NCA reference the portal returns.
5. Back on the case, mark it submitted and record the reference:
   ```
   POST /api/v1/admin/safety/csea/cases/<case_id>/submit
   { "nca_reference": "…", "submitted_at": "<iso>", "priority": "…" }
   ```
   This stops the deadline timer and moves the case to submitted status.

If you miss the deadline, submit anyway and note the reason on the case. The service emits `qtiauth.safety.csea.sla_breached.v1` for each type internally, but nothing about the content ever leaves the case.

## After submitting

- The evidence blob stays under the legal hold and is destroyed by `safety.csea_retention` after `retention.csea_evidence` (365 d by default), with an audit record.
- The NCA reference is kept for `retention.csea_nca_reference` (1825 d, five years) and then cleared.
- If the reported account is deleted while the case is open, its data is erased from every service and object storage. The legal-hold copy of the CSEA evidence stays. Do not clear the hold until retention has elapsed.
- If the NCA comes back with a question, use their portal; do not put the question or its answer on the case's staff notes unless it strictly names no case content.

## When you're not sure

The case exists because a first-line moderator classified it as CSEA. If you don't think it is, don't close it: re-classify to another taxonomy type from the case page, which moves the report back to the moderation queue and closes the CSEA case without submitting. Every reclassification is audited.

If you can't submit and can't reclassify (for example the NCA portal is down), escalate to `safety.accountable_person` immediately. Missing a priority 1 deadline without escalation is a bigger problem than a portal outage.
