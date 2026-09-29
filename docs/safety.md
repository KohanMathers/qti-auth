# Safety

The safety service accepts user, content and machine reports, holds the moderation queue and runs the CSEA / NCA workflow. It's part of the `safety` compose profile and uses the `safety` schema. The legal parameters behind the NCA workflow are recorded in [compliance/csea.md](compliance/csea.md).

Reports are accepted from three places: a signed-in user through the account UI, a game or service through the intake API, and a machine classifier as an automated flag. The intake API accepts both service tokens (`auth: service`) and OAuth access tokens with `safety.reports.submit` (`auth: oauth`), so game servers, chat filters and other back-ends can submit without holding a user session.

## Settings

```yaml
safety:
  reports:
    reporter_ack: true
    reporter_outcome: true
    default_priority: normal
    max_note_length: 2000
    max_snapshot_bytes: 65536
    sla_check_interval: 1m
  taxonomy:
    types: {} # ids you set replace the built-in type of the same name
  actions:
    types: {} # ids you set replace the built-in action of the same name
  rules:
    items: {} # ids you set replace the built-in rule of the same name
  restrictions: [chat, ugc, username_change]
  bans:
    require_second_approval: false
  appeals:
    max_length: 2000
  csea_alert_emails: []
  csea:
    encryption_key: '${env:APP_ENCRYPTION_KEY}'
    nca_portal_url: ''
    protective_lock: 7d
    priority_1: 15m
    priority_2: 4h
    priority_3: 24h
  accountable_person:
    name: ''
    role: ''

features:
  safety:
    reports: { enabled: true }
    game_intake: { enabled: true }
    automated_flags: { enabled: true }
    moderation: { enabled: true }
    appeals: { enabled: true }
    csea: { enabled: true }

retention:
  safety_reports: 730d
  csea_evidence: 365d
  csea_nca_reference: 1825d
```

- `reports.reporter_ack` sends the `safety_report_received` email when the reporter left an address. It's off for anonymous reports and for reports that had no contact channel.
- `reports.reporter_outcome` sends the `safety_report_outcome` email once a moderator resolves or dismisses the report. Neither template names or hints at the reported user.
- `reports.default_priority` is used when the type's own `default_priority` is `normal` and the caller doesn't set one.
- `reports.sla_check_interval` bounds how quickly `safety.report.sla_breached` fires after a deadline; the sweep also runs on the scheduler tick `safety.sla_sweep`.
- `taxonomy.types` merges over the defaults. To replace the built-in `hate` type you set `taxonomy.types.hate: { … }`; other built-in types stay as they are.
- `csea_alert_emails` receive the alert-only notification that a CSEA case exists. The email is a link; it never contains case content.
- `csea.encryption_key` is a base64 32-byte key that encrypts CSEA evidence at rest. Safety will not start with CSEA enabled unless this is set. Reuse `APP_ENCRYPTION_KEY` unless you want a separate key.
- `csea.nca_portal_url` is shown to staff as the NCA CSEA-IRP submission destination. Leave it empty until the operator has registered; see [compliance/csea.md](compliance/csea.md).
- `csea.protective_lock` is how long a one-click protective lock lasts. Staff can lift it earlier.
- `csea.priority_1`, `priority_2` and `priority_3` are the operational NCA submission windows. Defaults are 15 minutes, 4 hours and 24 hours; the legal language they implement is in [compliance/csea.md](compliance/csea.md).
- `retention.csea_evidence` is how long encrypted evidence is kept after the NCA report is sent (default 365d). `retention.csea_nca_reference` is how long the unique NCA reference is kept (default 1825d). `safety.csea_retention` destroys due evidence with an audit record.
- `accountable_person` is shown in the admin UI and available to legal document templates (ICU A2).
- `actions.types` merges over the built-in actions (`warn`, `restrict`, `force_username_reset`, `lock`, `ban`, `remove_content`, `proscribed_org_removal`). Each has a display name and an `enabled` flag.
- `rules.items` is the list staff must pick from for the statement of reasons.
- `restrictions` are the named restrictions a `restrict` action may apply. Identity copies active names into the identity token and the `restrictions` claim.
- `bans.require_second_approval` holds a permanent ban (`ban` or `proscribed_org_removal`) until a second, different moderator confirms it.
- `appeals.max_length` bounds the appeal form. When Support tickets are enabled the appeal is also opened as a ticket; otherwise Safety stores it.

## Taxonomy

Each type has a name, subtypes, `default_priority`, `sla` (a duration) and a `csea` flag. Priorities are `low`, `normal`, `high`, `urgent`. The default taxonomy is 9 OSA-mapped types (CSEA, terrorism, violence, self-harm, hate, sexual content, fraud, illegal goods, other) with a 24h default SLA and 1h for CSEA and terrorism. `csea: true` opens a CSEA case rather than a moderation ticket, so those reports are never emitted as `safety.report.created` and never appear on the moderation admin routes.

You can add a type or override a built-in one:

```yaml
safety:
  taxonomy:
    types:
      hate:
        name: Hate and harassment
        default_priority: high
        sla: 12h
        csea: false
        subtypes:
          - { id: targeted_harassment, name: Targeted harassment }
          - { id: protected_characteristic, name: Hate against a protected characteristic }
      cheating:
        name: Cheating in a game
        default_priority: normal
        sla: 48h
        csea: false
        subtypes:
          - { id: exploits, name: Exploits or hacks }
          - { id: griefing, name: Persistent griefing }
```

## Routes

| Route                                                        | Auth    | Purpose                                                 |
| ------------------------------------------------------------ | ------- | ------------------------------------------------------- |
| `GET  /api/v1/safety/taxonomy`                               | none    | Types and subtypes for the reporter UI                  |
| `POST /api/v1/safety/reports`                                | session | Report a user or piece of content                       |
| `GET  /api/v1/safety/reports/:report_id`                     | session | Check the status of a report you filed                  |
| `POST /api/v1/safety/appeals`                                | session | Appeal a lock, ban or restriction                       |
| `GET  /api/v1/safety/appeals`                                | session | Appeals you filed                                       |
| `POST /api/v1/safety/intake/reports`                         | service | Game or service report intake                           |
| `POST /api/v1/safety/intake/flags`                           | service | Automated flag intake (classifier name + score)         |
| `GET  /api/v1/admin/safety/catalog`                          | session | Actions, rules, restrictions and accountable person     |
| `GET  /api/v1/admin/safety/reports`                          | session | Moderation queue (CSEA omitted)                         |
| `GET  /api/v1/admin/safety/reports/:report_id`               | session | Report detail for moderators                            |
| `POST /api/v1/admin/safety/reports/:report_id/actions`       | session | Apply a moderation action                               |
| `POST /api/v1/admin/safety/reports/:report_id/dismiss`       | session | Dismiss a report                                        |
| `POST /api/v1/admin/safety/approvals/:approval_id/confirm`   | session | Second-moderator confirmation of a permanent ban        |
| `GET  /api/v1/admin/safety/users/:user_id/history`           | session | Actions against an account                              |
| `GET  /api/v1/admin/safety/moderators/:moderator_id/history` | session | Actions a moderator applied                             |
| `GET  /api/v1/admin/safety/appeals`                          | session | Appeals                                                 |
| `POST /api/v1/admin/safety/appeals/:appeal_id/resolve`       | session | Lift an action or leave it in place                     |
| `POST /api/v1/admin/safety/reports/:report_id/reclassify`    | session | Change type; opens a CSEA case when the type is flagged |
| `GET  /api/v1/admin/safety/csea/cases`                       | session | CSEA cases (no case content)                            |
| `GET  /api/v1/admin/safety/csea/cases/:case_id`              | session | Case detail, checklist and decrypted evidence           |
| `POST /api/v1/admin/safety/csea/cases/:case_id/checklist`    | session | Update the NCA submission checklist                     |
| `POST /api/v1/admin/safety/csea/cases/:case_id/submit`       | session | Record the NCA unique reference and time                |
| `POST /api/v1/admin/safety/csea/cases/:case_id/protect`      | session | One-click lock and content-removal request              |
| `POST /api/v1/admin/safety/csea/cases/:case_id/close`        | session | Not CSEA: destroy evidence and return to the queue      |

Intake routes accept `auth: service` (a service token) or `auth: oauth` (an OAuth access token). Both need the `safety.reports.submit` scope. When a game server calls with a client whose id is `game:<game_id>`, the intake refuses `game_id` values that don't match. A game may only report on its own player content.

## Snapshots

The user, game and service routes accept an optional `snapshot`:

```json
{
  "content_type": "text/plain",
  "content": "…"
}
```

The snapshot is stored on the report and never rendered back to the reported user. Its total size is bounded by `reports.max_snapshot_bytes`. CSEA cases copy it into the encrypted evidence store and delete the plaintext copy.

## SLA breaches

Each report gets an `sla_deadline` from the type's `sla`. The scheduler tick `safety.sla_sweep` runs the sweep, and any report past its deadline that hasn't yet been actioned emits `safety.report.sla_breached` exactly once. The event is available to webhooks; CSEA reports are excluded even from a `*` subscription.

## Reporter anonymity

The reporter's contact address is stored on the report but never appears in webhook payloads, admin responses, logs or email bodies. `safety.report.acknowledged` events carry a salted hash of the address only, using `observability.logs.user_id_hash_key`.

## Events

| Event                                         | When it fires                                           | Webhook-delivered |
| --------------------------------------------- | ------------------------------------------------------- | ----------------- |
| `qtiauth.safety.report.created.v1`            | A non-CSEA report or flag was accepted                  | yes               |
| `qtiauth.safety.flag.created.v1`              | An automated flag was recorded                          | yes               |
| `qtiauth.safety.report.acknowledged.v1`       | The reporter ack email was queued                       | no                |
| `qtiauth.safety.report.actioned.v1`           | A moderator applied an enforcement action               | yes               |
| `qtiauth.safety.report.dismissed.v1`          | A moderator dismissed a report                          | yes               |
| `qtiauth.safety.report.sla_breached.v1`       | The first-action SLA passed without a moderation action | yes               |
| `qtiauth.safety.appeal.created.v1`            | Someone appealed a lock, ban or restriction             | yes               |
| `qtiauth.safety.appeal.resolved.v1`           | Staff lifted an action or left it in place              | yes               |
| `qtiauth.safety.content.removal_requested.v1` | A `remove_content` action was applied                   | yes               |
| `qtiauth.safety.csea.case_opened.v1`          | A CSEA case was opened. Payload is the case id only     | no                |
| `qtiauth.safety.csea.enforced.v1`             | A one-click protective lock was applied                 | no                |

## Data rights

Reports the user filed, actions taken against them and appeals they opened are included in `export_user`. Erasure clears personal fields (`reporter_user_id`, `reporter_contact`, `reporter_locale`, `target_user_id` on non-CSEA reports, `moderation_actions.user_id`, `appeals.user_id` and the appeal body) so a deleted account no longer identifies a subject, while the report record and its snapshot are kept for the retention window. CSEA evidence is not exported. Deleting the reported account leaves encrypted held evidence and `csea_cases.target_user_id` intact.

## Moderation

Staff with `safety.reports.read` see the queue (oldest SLA deadline first; CSEA omitted) and per-user / per-moderator history. `safety.actions.apply` applies a configured action. Every action needs a rule from `safety.rules`. Identity consumes `safety.report.actioned` and `safety.csea.enforced` for the real effect:

| Action                   | Effect                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------- |
| `warn`                   | Statement of reasons email. No restriction.                                           |
| `restrict`               | Named restrictions on the identity token, with optional expiry.                       |
| `force_username_reset`   | The user must choose a new username.                                                  |
| `lock`                   | Temporary. The account can only reach appeals, support and data rights. Auto-expires. |
| `ban`                    | Permanent until lifted. Same access as `lock`.                                        |
| `remove_content`         | Emits `safety.content.removal_requested` for the originating game or service.         |
| `proscribed_org_removal` | Ban with reason code `icu_h1`.                                                        |

The statement of reasons names the rule, the action, its duration and a link to appeal. Locked, banned or restricted users appeal through `POST /api/v1/safety/appeals`. Staff resolve an appeal by lifting the action or leaving it in place; identity consumes a lift. Permanent bans can require a second moderator when `safety.bans.require_second_approval` is on; that request answers `202` with `approval_id`.

## CSEA / NCA workflow

A report whose type has `csea: true`, or one a moderator reclassifies to such a type, opens a CSEA case instead of a moderation ticket. Only holders of `safety.csea.access` can see the case, snapshot or evidence. That permission is `wildcard: false`: `*` and `safety.*` do not cover it. Every case view is audited as `csea.case.viewed`.

On open, the snapshot and report metadata are encrypted at rest (AES-256-GCM) and the plaintext snapshot is removed from `report_snapshots`. Safety places a legal hold through identity (`place_legal_hold`, reason `Open investigation`) and copies sealed blobs under `legal-hold/` when object storage is enabled. Held evidence survives account deletion.

The case page carries the NCA CSEA-IRP checklist (Schedule 1 fields from SI 2026/268), the configured `nca_portal_url`, and the submission deadline from the case's NCA priority. Staff submit through the portal, then record the unique reference, time and a completed declaration. One-click protect emits `safety.csea.enforced` (identity applies the lock) and, for a content target, `safety.content.removal_requested`. Closing a case that is not CSEA destroys the evidence, lifts the hold and returns the report to the moderation queue.

`csea_alert_emails` get `csea_case_opened`, which is a link and never case content. CSEA events are not webhook-deliverable, even to `*`. Logs, traces and metrics labels never include case content; `qtiauth_safety_csea_cases_open` is a count only.
