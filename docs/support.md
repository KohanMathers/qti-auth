# Support

The support service holds tickets, appeals and canned responses. It's part of the `support` compose profile and uses the `support` schema. Guest tickets, attachments and the knowledge base are later work.

Signed-in users open tickets on the support surface. Banned and locked accounts can open an appeal ticket, and nothing else. When Safety is running, an appeal is linked to the enforcement action and Safety asks Support to open the ticket over the bus.

## Settings

```yaml
support:
  auto_close_after: 7d
  max_subject_length: 200
  max_body_length: 8000
  categories: {} # ids you set replace the built-in category of the same name

features:
  support:
    tickets: { enabled: true }
    kb: { enabled: true }
    guest_tickets: { enabled: true }
    attachments: { enabled: false }

retention:
  closed_tickets: 730d

rate_limits:
  ticket_create: { per: user, limit: 5, window: 1h }
```

- `auto_close_after` closes tickets waiting on the user. A reminder is sent at the halfway point. The sweep runs on the scheduler tick `support.auto_close`.
- `max_subject_length` and `max_body_length` bound the subject, public replies and internal notes.
- `categories` merges over the defaults. To replace the built-in `billing` category you set `categories.billing: { … }`; other built-in categories stay as they are. Exactly one category must have `appeal: true`.
- `features.support.tickets` turns the ticket routes off. Knowledge base, guest tickets and attachments are accepted in config for later work; turning them on does not enable those features yet. Attachments also need `storage.enabled`.
- `retention.closed_tickets` is how long a closed ticket, its messages and notes are kept after `resolved_at`. Open tickets are not swept.
- `rate_limits.ticket_create` applies to opening a ticket or an appeal.

## Categories

Each category has a `name`, `guest_allowed` (for later guest tickets) and `appeal`. Priorities are `low`, `normal`, `high` and `urgent`. Statuses are `open` (waiting on staff), `pending` (waiting on the user) and `closed`. The defaults are Account, Billing, Technical, Other and Appeal.

You can add a category or override a built-in one:

```yaml
support:
  categories:
    billing:
      name: Payments
      guest_allowed: false
      appeal: false
    hardware:
      name: Hardware
      guest_allowed: true
      appeal: false
```

The appeal category cannot be chosen on `POST /api/v1/support/tickets`. Appeals go through `POST /api/v1/support/appeals`, which forces that category.

## Routes

| Route                                                   | Auth    | Purpose                                                 |
| ------------------------------------------------------- | ------- | ------------------------------------------------------- |
| `GET  /api/v1/support/categories`                       | session | Categories that can be chosen when opening a ticket     |
| `POST /api/v1/support/tickets`                          | session | Open a ticket                                           |
| `GET  /api/v1/support/tickets`                          | session | Tickets you opened                                      |
| `GET  /api/v1/support/tickets/:ticket_id`               | session | A ticket you opened, with messages                      |
| `POST /api/v1/support/tickets/:ticket_id/replies`       | session | Reply to your ticket                                    |
| `POST /api/v1/support/tickets/:ticket_id/close`         | session | Close your ticket                                       |
| `POST /api/v1/support/tickets/:ticket_id/reopen`        | session | Reopen your ticket                                      |
| `POST /api/v1/support/tickets/:ticket_id/rate`          | session | Rate a closed ticket 1–5                                |
| `POST /api/v1/support/appeals`                          | session | Appeal a lock, ban or restriction                       |
| `GET  /api/v1/admin/support/tickets`                    | session | Staff queue                                             |
| `GET  /api/v1/admin/support/tickets/:ticket_id`         | session | Ticket detail, messages and internal notes              |
| `POST /api/v1/admin/support/tickets/:ticket_id/replies` | session | Reply as staff, optionally from a canned response       |
| `POST /api/v1/admin/support/tickets/:ticket_id/notes`   | session | Add an internal note                                    |
| `PATCH /api/v1/admin/support/tickets/:ticket_id`        | session | Assign, recategorise or change priority                 |
| `POST /api/v1/admin/support/tickets/:ticket_id/close`   | session | Close a ticket                                          |
| `POST /api/v1/admin/support/tickets/:ticket_id/reopen`  | session | Reopen a ticket                                         |
| `GET  /api/v1/admin/support/macros`                     | session | Canned responses                                        |
| `POST /api/v1/admin/support/macros`                     | session | Create a canned response                                |
| `PATCH /api/v1/admin/support/macros/:macro_id`          | session | Edit a canned response                                  |
| `DELETE /api/v1/admin/support/macros/:macro_id`         | session | Delete a canned response                                |
| `GET  /api/v1/admin/support/metrics`                    | session | First-response, resolution, CSAT, by category and agent |

User ticket and appeal routes allow `active`, `banned` and `locked` accounts, except `POST /api/v1/support/tickets`, which is `active` only. Staff routes need `support.tickets.staff`. Ticket ids in the path are UUIDs; the sequential `number` is in the JSON.

## Appeals

Banned and locked accounts can open an appeal and then view, reply, close, reopen and rate it. They cannot open a regular ticket. The category is forced to the configured appeal type. There is at most one open appeal per user per Safety action (`action_id`), and at most one open appeal with no action when Safety is not in the picture.

When Safety is enabled it stores the appeal and asks Support over `qtiauth.rpc.support.create_appeal` with `{ user_id, action_id, body }`. If a ticket already exists, Support returns that `ticket_id` instead of opening another.

## Emails

New tickets mail staff who can receive `support.new_tickets`, through `qtiauth.rpc.identity.staff_alert_recipients`. A staff reply mails the user (`ticket_reply`). A close, reopen or auto-close mails the user (`ticket_status`). The halfway reminder is `ticket_reminder`. User mail honours `support.ticket_updates`. Bodies and subjects are never put in the email.

## Auto-close

A staff reply moves the ticket to `pending` and resets `waiting_since`. After `auto_close_after / 2` without a user reply, Support sends the reminder once. After the full window it closes the ticket, emits `support.ticket.status_changed` with `auto: true`, and mails the user. A user reply moves the ticket back to `open` and clears the reminder.

## Events

| Event                                      | When it fires                                       | Webhook-delivered |
| ------------------------------------------ | --------------------------------------------------- | ----------------- |
| `qtiauth.support.ticket.created.v1`        | A ticket or appeal was opened                       | yes               |
| `qtiauth.support.ticket.replied.v1`        | A user or staff member replied. The body is omitted | no                |
| `qtiauth.support.ticket.status_changed.v1` | Status changed, including auto-close                | yes               |

Payloads carry ids, the sequential number, category, priority and flags. They never include the subject or message body.

## Data rights

Tickets the user opened and their public messages are included in `export_user`. Internal notes are not. Erasure nulls `user_id`, blanks the subject and the user's message bodies and notes, and leaves staff replies so the queue still makes sense. `retention.sweep` deletes closed tickets after `retention.closed_tickets`.

Identity's account detail asks `qtiauth.rpc.support.user_tickets` with `{ user_id }` and gets `{ items }`.

## Metrics

| Metric                                   | Labels               |
| ---------------------------------------- | -------------------- |
| `qtiauth_support_tickets_total`          | `category`           |
| `qtiauth_support_first_response_seconds` |                      |
| `qtiauth_support_resolution_seconds`     |                      |
| `qtiauth_support_csat_total`             | `rating`             |
| `qtiauth_support_auto_closes_total`      |                      |
| `qtiauth_support_tickets_open`           | `status`, `category` |

`GET /api/v1/admin/support/metrics` is the staff view: first-response and resolution averages, CSAT counts, open/pending/closed by category, and closed counts by assigned agent. Prometheus labels never include agent ids.

Errors, on top of the [codes every service can return](services.md#errors):

| Code                       | Status | When                                                      |
| -------------------------- | ------ | --------------------------------------------------------- |
| `SUPPORT_TICKETS_DISABLED` | 404    | `features.support.tickets` is off                         |
| `SUPPORT_TICKET_NOT_FOUND` | 404    | No such ticket, or it isn't yours                         |
| `SUPPORT_MACRO_NOT_FOUND`  | 404    | No such canned response                                   |
| `SUPPORT_CATEGORY_UNKNOWN` | 400    | The category id is not in config                          |
| `SUPPORT_CATEGORY_APPEAL`  | 400    | A regular ticket used the appeal category, or the reverse |
| `SUPPORT_TICKET_INVALID`   | 400    | Subject, body or note longer than the configured maximum  |
| `SUPPORT_TICKET_CLOSED`    | 409    | The ticket is already closed                              |
| `SUPPORT_TICKET_OPEN`      | 409    | The ticket is still open (reopen or rate)                 |
| `SUPPORT_TICKET_RATED`     | 409    | The ticket has already been rated                         |
| `SUPPORT_APPEAL_EXISTS`    | 409    | An open appeal already exists for this action             |
