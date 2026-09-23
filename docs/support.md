# Support

The support service holds tickets, appeals, guest tickets, attachments and canned responses. It's part of the `support` compose profile and uses the `support` schema. The knowledge base is later work.

Signed-in users open tickets on the support surface. Banned and locked accounts can open an appeal ticket, and nothing else. When Safety is running, an appeal is linked to the enforcement action and Safety asks Support to open the ticket over the bus.

## Settings

```yaml
support:
  auto_close_after: 7d
  max_subject_length: 200
  max_body_length: 8000
  guest_code_ttl: 15m
  guest_link_ttl: 7d
  attachment_max_bytes: 524288
  attachment_download_ttl: 15m
  categories: {} # ids you set replace the built-in category of the same name

features:
  support:
    tickets: { enabled: true }
    kb: { enabled: true }
    guest_tickets: { enabled: true }
    attachments: { enabled: false }

retention:
  closed_tickets: 730d
  tokens: 24h

rate_limits:
  ticket_create: { per: user, limit: 5, window: 1h }
  guest_ticket: { per: ip, limit: 3, window: 1h }
```

- `auto_close_after` closes tickets waiting on the user. A reminder is sent at the halfway point. The sweep runs on the scheduler tick `support.auto_close`.
- `max_subject_length` and `max_body_length` bound the subject, public replies and internal notes.
- `guest_code_ttl` is how long an emailed guest code works. A newer unused code replaces the previous one for that address.
- `guest_link_ttl` is how long a guest magic link works. Later emails send a new link. Older links keep working until they expire.
- `attachment_max_bytes` is the largest attachment. The upload is base64 inside JSON, so `gateway.http.max_body_size` has to be about a third larger than this. The default is 512 KiB so it fits the default 1 MiB gateway body.
- `attachment_download_ttl` is how long a signed download URL works.
- `categories` merges over the defaults. To replace the built-in `billing` category you set `categories.billing: { … }`; other built-in categories stay as they are. Exactly one category must have `appeal: true`.
- `features.support.tickets` turns the ticket routes off. `features.support.guest_tickets` turns guest routes off. `features.support.attachments` turns uploads and downloads off; it also needs an object store. The knowledge base is accepted in config for later work.
- `retention.closed_tickets` is how long a closed ticket, its messages, notes and attachment objects are kept after `resolved_at`. Open tickets are not swept.
- `retention.tokens` also sweeps guest codes, magic links and the CAPTCHA attempt counters.
- `rate_limits.ticket_create` applies to opening a ticket or an appeal. `rate_limits.guest_ticket` applies to asking for a guest code and opening a guest ticket. The gateway enforces both.

## Categories

Each category has a `name`, `guest_allowed` and `appeal`. Guest tickets can only use a category with `guest_allowed: true` that is not the appeal category. Priorities are `low`, `normal`, `high` and `urgent`. Statuses are `open` (waiting on staff), `pending` (waiting on the user) and `closed`. The defaults are Account, Billing, Technical, Other and Appeal. Billing, Technical and Other allow guests.

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

| Route                                                                               | Auth    | Purpose                                                 |
| ----------------------------------------------------------------------------------- | ------- | ------------------------------------------------------- |
| `GET  /api/v1/support/categories`                                                   | session | Categories that can be chosen when opening a ticket     |
| `POST /api/v1/support/tickets`                                                      | session | Open a ticket                                           |
| `GET  /api/v1/support/tickets`                                                      | session | Tickets you opened                                      |
| `GET  /api/v1/support/tickets/:ticket_id`                                           | session | A ticket you opened, with messages                      |
| `POST /api/v1/support/tickets/:ticket_id/replies`                                   | session | Reply to your ticket                                    |
| `POST /api/v1/support/tickets/:ticket_id/close`                                     | session | Close your ticket                                       |
| `POST /api/v1/support/tickets/:ticket_id/reopen`                                    | session | Reopen your ticket                                      |
| `POST /api/v1/support/tickets/:ticket_id/rate`                                      | session | Rate a closed ticket 1–5                                |
| `POST /api/v1/support/appeals`                                                      | session | Appeal a lock, ban or restriction                       |
| `POST /api/v1/support/tickets/:ticket_id/attachments`                               | session | Attach a file to your ticket                            |
| `POST /api/v1/support/tickets/:ticket_id/attachments/:attachment_id/download`       | session | Signed download URL for your attachment                 |
| `GET  /api/v1/support/guest/categories`                                             | none    | Categories a guest can choose                           |
| `GET  /api/v1/support/guest/captcha`                                                | none    | Whether this IP must solve a CAPTCHA                    |
| `POST /api/v1/support/guest/codes`                                                  | none    | Email a one-time code                                   |
| `POST /api/v1/support/guest/tickets`                                                | none    | Open a ticket with that code                            |
| `POST /api/v1/support/guest/tickets/view`                                           | none    | Read a ticket with its magic-link token                 |
| `POST /api/v1/support/guest/tickets/replies`                                        | none    | Reply to a guest ticket                                 |
| `POST /api/v1/support/guest/tickets/close`                                          | none    | Close a guest ticket                                    |
| `POST /api/v1/support/guest/tickets/reopen`                                         | none    | Reopen a guest ticket                                   |
| `POST /api/v1/support/guest/tickets/rate`                                           | none    | Rate a closed guest ticket                              |
| `POST /api/v1/support/guest/attachments`                                            | none    | Attach a file to a guest ticket                         |
| `POST /api/v1/support/guest/attachments/download`                                   | none    | Signed download URL for a guest attachment              |
| `GET  /api/v1/admin/support/tickets`                                                | session | Staff queue                                             |
| `GET  /api/v1/admin/support/tickets/:ticket_id`                                     | session | Ticket detail, messages and internal notes              |
| `POST /api/v1/admin/support/tickets/:ticket_id/replies`                             | session | Reply as staff, optionally from a canned response       |
| `POST /api/v1/admin/support/tickets/:ticket_id/notes`                               | session | Add an internal note                                    |
| `PATCH /api/v1/admin/support/tickets/:ticket_id`                                    | session | Assign, recategorise or change priority                 |
| `POST /api/v1/admin/support/tickets/:ticket_id/close`                               | session | Close a ticket                                          |
| `POST /api/v1/admin/support/tickets/:ticket_id/reopen`                              | session | Reopen a ticket                                         |
| `POST /api/v1/admin/support/tickets/:ticket_id/attachments`                         | session | Attach a file as staff                                  |
| `POST /api/v1/admin/support/tickets/:ticket_id/attachments/:attachment_id/download` | session | Signed download URL. Non-images set `warning`           |
| `GET  /api/v1/admin/support/macros`                                                 | session | Canned responses                                        |
| `POST /api/v1/admin/support/macros`                                                 | session | Create a canned response                                |
| `PATCH /api/v1/admin/support/macros/:macro_id`                                      | session | Edit a canned response                                  |
| `DELETE /api/v1/admin/support/macros/:macro_id`                                     | session | Delete a canned response                                |
| `GET  /api/v1/admin/support/metrics`                                                | session | First-response, resolution, CSAT, by category and agent |

User ticket and appeal routes allow `active`, `banned` and `locked` accounts, except `POST /api/v1/support/tickets`, which is `active` only. Staff routes need `support.tickets.staff`. Ticket ids in the path are UUIDs; the sequential `number` is in the JSON.

## Appeals

Banned and locked accounts can open an appeal and then view, reply, close, reopen and rate it. They cannot open a regular ticket. The category is forced to the configured appeal type. There is at most one open appeal per user per Safety action (`action_id`), and at most one open appeal with no action when Safety is not in the picture.

When Safety is enabled it stores the appeal and asks Support over `qtiauth.rpc.support.create_appeal` with `{ user_id, action_id, body }`. If a ticket already exists, Support returns that `ticket_id` instead of opening another.

## Guest tickets

A signed-out person asks `POST /api/v1/support/guest/codes` with `{ email }`. The answer is always `202` with `{ status: 'sent' }`. The code is six digits, hashed at rest, and a newer code invalidates unused ones for that address. Gmail addresses are normalised the same way as account email (`accounts.email_normalization`) before the code is looked up. The ticket stores the address as it was typed on create.

After `captcha.after` starts from the same IP, the next start needs a CAPTCHA. A missing solution is `SUPPORT_CAPTCHA_REQUIRED` (403) and a bad one is `SUPPORT_CAPTCHA_INVALID` (400). The problem body includes the widget fields (`provider`, `challenge` or `site_key`), same as sign-in. `GET /api/v1/support/guest/captcha` reports whether this IP must solve one.

`POST /api/v1/support/guest/tickets` takes `{ email, code, category_id, subject, body }`. The code is single-use. The response is `{ number }` only. The magic-link token is emailed as `guest_ticket` and is not in the HTTP body. The link opens `{support origin}{base}/guest?token=`. Later replies, status changes and reminders email a new link. The old link keeps working until `guest_link_ttl`.

View, reply, close, reopen, rate and attachments take the token in the JSON body. The ticket has no `user_id`. Events record the actor as system `guest`. Guest mail does not check `support.ticket_updates`, because there is no account.

Guest tickets are not tied to an account, so account erasure does not remove them. `retention.closed_tickets` deletes them after they close.

## Attachments

Uploads are JSON `{ filename, content }` with `content` as base64. The type comes from the bytes, not the filename. JPEG, PNG, GIF, WebP, PDF (`%PDF-`) and UTF-8 plain text are accepted. HTML, SVG, XML, script and other markup are rejected with `SUPPORT_ATTACHMENT_INVALID`, including a `.html` file renamed to `.png`. Empty and other binary files are rejected the same way.

`features.support.attachments` defaults to off (`SUPPORT_ATTACHMENTS_DISABLED`). With the flag on and no object store, uploads return `SUPPORT_STORAGE_UNAVAILABLE`. Listing a ticket returns no attachments while the flag is off.

Download routes return `{ url, expires_at }`. The URL is signed with `Content-Disposition: attachment` and the sniffed content type, so a browser downloads the file. Staff ticket JSON sets `warning: true` when the type is not an image. User and guest responses omit `warning`.

Signed-in attachments are included in `export_user` (metadata, and `content_base64` when a store is present) and their objects are deleted on erasure. Closed-ticket retention deletes attachment objects before the rows.

## Emails

New tickets mail staff who can receive `support.new_tickets`, through `qtiauth.rpc.identity.staff_alert_recipients`. A guest code is `guest_code`. Opening a guest ticket also sends `guest_ticket` to that address. A staff reply mails the user (`ticket_reply`). A close, reopen or auto-close mails the user (`ticket_status`). The halfway reminder is `ticket_reminder`. Signed-in user mail honours `support.ticket_updates`. Guest mail does not. Bodies and subjects are never put in the email, and neither is a guest code or magic-link token in logs.

## Auto-close

A staff reply moves the ticket to `pending` and resets `waiting_since`. After `auto_close_after / 2` without a user reply, Support sends the reminder once. After the full window it closes the ticket, emits `support.ticket.status_changed` with `auto: true`, and mails the user. A user reply moves the ticket back to `open` and clears the reminder.

## Events

| Event                                      | When it fires                                       | Webhook-delivered |
| ------------------------------------------ | --------------------------------------------------- | ----------------- |
| `qtiauth.support.ticket.created.v1`        | A ticket or appeal was opened                       | yes               |
| `qtiauth.support.ticket.replied.v1`        | A user or staff member replied. The body is omitted | no                |
| `qtiauth.support.ticket.status_changed.v1` | Status changed, including auto-close                | yes               |

Payloads carry ids, the sequential number, category, priority and flags. `ticket.created` may include `guest: true` when the ticket has no account. They never include the subject or message body.

## Data rights

Tickets the user opened, their public messages and their attachment metadata are included in `export_user`. The export also includes `content_base64` when an object store is configured. Internal notes are not. Erasure nulls `user_id`, blanks the subject and the user's message bodies and notes, deletes that user's attachment objects, and leaves staff replies so the queue still makes sense. `retention.sweep` deletes closed tickets and their attachment objects after `retention.closed_tickets`, and deletes expired guest codes, links and attempt rows with `retention.tokens`.

Identity's account detail asks `qtiauth.rpc.support.user_tickets` with `{ user_id }` and gets `{ items }`.

## Metrics

| Metric                                   | Labels               |
| ---------------------------------------- | -------------------- |
| `qtiauth_support_tickets_total`          | `category`           |
| `qtiauth_support_guest_tickets_total`    |                      |
| `qtiauth_support_first_response_seconds` |                      |
| `qtiauth_support_resolution_seconds`     |                      |
| `qtiauth_support_csat_total`             | `rating`             |
| `qtiauth_support_auto_closes_total`      |                      |
| `qtiauth_support_tickets_open`           | `status`, `category` |

`GET /api/v1/admin/support/metrics` is the staff view: first-response and resolution averages, CSAT counts, open/pending/closed by category, closed counts by assigned agent, and `guest_tickets`. Prometheus labels never include agent ids.

Errors, on top of the [codes every service can return](services.md#errors):

| Code                           | Status | When                                                      |
| ------------------------------ | ------ | --------------------------------------------------------- |
| `SUPPORT_TICKETS_DISABLED`     | 404    | `features.support.tickets` is off                         |
| `SUPPORT_TICKET_NOT_FOUND`     | 404    | No such ticket, or it isn't yours                         |
| `SUPPORT_MACRO_NOT_FOUND`      | 404    | No such canned response                                   |
| `SUPPORT_CATEGORY_UNKNOWN`     | 400    | The category id is not in config                          |
| `SUPPORT_CATEGORY_APPEAL`      | 400    | A regular ticket used the appeal category, or the reverse |
| `SUPPORT_TICKET_INVALID`       | 400    | Subject, body or note longer than the configured maximum  |
| `SUPPORT_TICKET_CLOSED`        | 409    | The ticket is already closed                              |
| `SUPPORT_TICKET_OPEN`          | 409    | The ticket is still open (reopen or rate)                 |
| `SUPPORT_TICKET_RATED`         | 409    | The ticket has already been rated                         |
| `SUPPORT_APPEAL_EXISTS`        | 409    | An open appeal already exists for this action             |
| `SUPPORT_GUEST_DISABLED`       | 404    | `features.support.guest_tickets` is off                   |
| `SUPPORT_CAPTCHA_REQUIRED`     | 403    | This IP must solve a CAPTCHA before another guest code    |
| `SUPPORT_CAPTCHA_INVALID`      | 400    | The CAPTCHA solution was rejected                         |
| `SUPPORT_GUEST_CODE_INVALID`   | 400    | The guest code is wrong, used or expired                  |
| `SUPPORT_GUEST_LINK_INVALID`   | 404    | The magic link is unknown or expired                      |
| `SUPPORT_CATEGORY_GUEST`       | 400    | The category is not open to guests                        |
| `SUPPORT_ATTACHMENTS_DISABLED` | 404    | `features.support.attachments` is off                     |
| `SUPPORT_ATTACHMENT_INVALID`   | 400    | The file is empty, too large, or not an allowed type      |
| `SUPPORT_STORAGE_UNAVAILABLE`  | 503    | Attachments are on and no object store is configured      |
| `SUPPORT_ATTACHMENT_NOT_FOUND` | 404    | No such attachment on this ticket                         |
