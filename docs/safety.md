# Safety

The safety service accepts user, content and machine reports, holds the moderation queue and runs the CSEA workflow. It's part of the `safety` compose profile and uses the `safety` schema. The NCA workflow (§P5.3) builds on the machinery introduced here.

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

retention:
  safety_reports: 730d
```

- `reports.reporter_ack` sends the `safety_report_received` email when the reporter left an address. It's off for anonymous reports and for reports that had no contact channel.
- `reports.reporter_outcome` sends the `safety_report_outcome` email once a moderator resolves or dismisses the report. Neither template names or hints at the reported user.
- `reports.default_priority` is used when the type's own `default_priority` is `normal` and the caller doesn't set one.
- `reports.sla_check_interval` bounds how quickly `safety.report.sla_breached` fires after a deadline; the sweep also runs on the scheduler tick `safety.sla_sweep`.
- `taxonomy.types` merges over the defaults. To replace the built-in `hate` type you set `taxonomy.types.hate: { … }`; other built-in types stay as they are.
- `csea_alert_emails` receive the alert-only notification that a CSEA case exists. The email never contains case content.
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

| Route                                                        | Auth    | Purpose                                             |
| ------------------------------------------------------------ | ------- | --------------------------------------------------- |
| `GET  /api/v1/safety/taxonomy`                               | none    | Types and subtypes for the reporter UI              |
| `POST /api/v1/safety/reports`                                | session | Report a user or piece of content                   |
| `GET  /api/v1/safety/reports/:report_id`                     | session | Check the status of a report you filed              |
| `POST /api/v1/safety/appeals`                                | session | Appeal a lock, ban or restriction                   |
| `GET  /api/v1/safety/appeals`                                | session | Appeals you filed                                   |
| `POST /api/v1/safety/intake/reports`                         | service | Game or service report intake                       |
| `POST /api/v1/safety/intake/flags`                           | service | Automated flag intake (classifier name + score)     |
| `GET  /api/v1/admin/safety/catalog`                          | session | Actions, rules, restrictions and accountable person |
| `GET  /api/v1/admin/safety/reports`                          | session | Moderation queue (CSEA omitted)                     |
| `GET  /api/v1/admin/safety/reports/:report_id`               | session | Report detail for moderators                        |
| `POST /api/v1/admin/safety/reports/:report_id/actions`       | session | Apply a moderation action                           |
| `POST /api/v1/admin/safety/reports/:report_id/dismiss`       | session | Dismiss a report                                    |
| `POST /api/v1/admin/safety/approvals/:approval_id/confirm`   | session | Second-moderator confirmation of a permanent ban    |
| `GET  /api/v1/admin/safety/users/:user_id/history`           | session | Actions against an account                          |
| `GET  /api/v1/admin/safety/moderators/:moderator_id/history` | session | Actions a moderator applied                         |
| `GET  /api/v1/admin/safety/appeals`                          | session | Appeals                                             |
| `POST /api/v1/admin/safety/appeals/:appeal_id/resolve`       | session | Lift an action or leave it in place                 |

Intake routes accept `auth: service` (a service token) or `auth: oauth` (an OAuth access token). Both need the `safety.reports.submit` scope. When a game server calls with a client whose id is `game:<game_id>`, the intake refuses `game_id` values that don't match — a game may only report on its own player content.

## Snapshots

The user, game and service routes accept an optional `snapshot`:

```json
{
  "content_type": "text/plain",
  "content": "…"
}
```

The snapshot is stored on the report and never rendered back to the reported user. Its total size is bounded by `reports.max_snapshot_bytes`.

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

## Data rights

Reports the user filed, actions taken against them and appeals they opened are included in `export_user`. Erasure clears personal fields (`reporter_user_id`, `reporter_contact`, `reporter_locale`, `target_user_id`, `moderation_actions.user_id`, `appeals.user_id` and the appeal body) so a deleted account no longer identifies a subject, while the report record and its snapshot are kept for the retention window.

## Moderation

Staff with `safety.reports.read` see the queue (oldest SLA deadline first; CSEA omitted) and per-user / per-moderator history. `safety.actions.apply` applies a configured action. Every action needs a rule from `safety.rules`. Identity consumes `safety.report.actioned` for the real effect:

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
