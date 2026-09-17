# Notifier

The notifier sends email. Other services queue an email by naming a template and giving its variables, and the notifier renders it, sends it through the configured provider and records the result in its delivery log. It always runs, uses the `notify` schema and has no public routes.

Queueing never waits for the provider, so a slow or broken mail server delays email but doesn't fail the request that asked for it.

## Settings

```yaml
email:
  provider: smtp # smtp | console
  from:
    auth: { name: Example Auth, address: auth@example.com }
    security: { name: Example Security, address: security@example.com }
    support: { name: Example Support, address: support@example.com }
  default_locale: en-GB
  templates_dir: templates/email
  smtp:
    host: localhost
    port: 587
    security: starttls # starttls | tls | none
    user: null
    password: '${env:SMTP_PASSWORD}'
    connect_timeout: 10s
    send_timeout: 30s
  queue: { max_attempts: 20, retry_delay: 10s, max_retry_delay: 30m }

retention:
  delivery_logs: 30d
```

- `provider` chooses how email leaves the stack (see [Providers](#providers)).
- `from` is the sender for each category of email. Sign-in and verification email comes from `auth`, security alerts from `security` and ticket email from `support`.
- `default_locale` is used when an email's locale has no templates, and every template must exist in it.
- `templates_dir` holds your template overrides, relative to the directory `qtiauth.yaml` is in (see [Templates](#templates)).
- `smtp` is only used by the `smtp` provider. `security: starttls` upgrades the connection and refuses a server that can't, `tls` connects over TLS from the start (usually port `465`), and `none` never uses TLS, which is only for a relay on a trusted network. Set `user` and `SMTP_PASSWORD` if the server needs authentication. `send_timeout` is how long the server may go quiet during a send.
- `queue` controls retries (see [Queue and retries](#queue-and-retries)).
- `retention.delivery_logs` is how long delivery log entries are kept.

## Providers

| Provider  | Sends                                                                                |
| --------- | ------------------------------------------------------------------------------------ |
| `smtp`    | Through any SMTP server or relay, reusing connections                                |
| `console` | Nowhere. Prints each email's headers and text part to the notifier's standard output |

`console` is for development only: it prints sign-in links and anything else in an email to the container's output. `config/qtiauth.dev.yaml` uses it, so `docker compose logs notifier` shows the magic links.

The other providers named in the spec (`brevo`, `postmark`, `ses`, `resend` and `mailgun`) aren't available yet. Bounce and complaint handling will come with them, since SMTP has no standard way to report them.

## Templates

Each email is a template made of three files in a directory named after its locale:

| File                 | Holds                                  |
| -------------------- | -------------------------------------- |
| `<name>.subject.txt` | The subject, on one line               |
| `<name>.txt`         | The plain-text part                    |
| `<name>.mjml`        | The HTML part, written in [MJML][mjml] |

[mjml]: https://documentation.mjml.io/

The built-in templates ship in the image, in `en-GB`. To change one, put a file with the same name under `templates_dir`, for example `config/templates/email/en-GB/magic_link.subject.txt`. It replaces only that file, and the other two keep their built-in versions. To add a language, add a directory such as `config/templates/email/fr/` with all three files for each template you translate.

An email is sent in its own locale if there's a template for it, then in the language alone (`fr` for `fr-CA`), then in `default_locale`.

### Variables

Templates insert values with `{{ name }}`. Each template has a fixed list of variables, and every template can also use:

| Variable                    | Value                     |
| --------------------------- | ------------------------- |
| `{{ brand.product_name }}`  | `branding.product_name`   |
| `{{ brand.company_name }}`  | `branding.company_name`   |
| `{{ brand.support_email }}` | `branding.support_email`  |
| `{{ brand.primary_color }}` | `branding.colors.primary` |

Values are escaped in the HTML part, and line breaks are removed from values in the subject. There are no conditionals or loops.

| Template              | Category   | Priority | Variables                    |
| --------------------- | ---------- | -------- | ---------------------------- |
| `magic_link`          | `auth`     | high     | `link`, `expires_in_minutes` |
| `email_verification`  | `auth`     | high     | `link`, `expires_in_minutes` |
| `password_reset`      | `security` | high     | `link`, `expires_in_minutes` |
| `email_change`        | `auth`     | high     | `link`, `expires_in_minutes` |
| `email_change_notice` | `security` | high     | `link`, `expires_in_days`    |

### Checks

The notifier checks every template when it starts and refuses to start if any of them is wrong, so a mistake shows up at deploy time rather than when someone is waiting for an email. It fails on:

- a variable a template isn't given, such as `{{ code }}` in `magic_link`
- a malformed or unclosed `{{`
- MJML that doesn't validate
- a template missing from `default_locale`, or a locale that has some of a template's files but not all three
- a file that isn't named after a template, or anything other than a locale directory in `templates_dir`

The error lists every problem with its file and line. To check your templates without starting the notifier:

```sh
docker compose run --rm notifier qtiauth templates check
```

`mj-include` is ignored, so keep each template in one file.

## Queue and retries

Services queue email on two JetStream work queues, `qtiauth.work.notifier.email.high` and `qtiauth.work.notifier.email.normal`. Sign-in, reset and verification email is high priority. Each queue has its own consumer, so a backlog of normal email never holds up a sign-in link.

When a send fails, the email is tried again after `queue.retry_delay`, doubling each time up to `queue.max_retry_delay`, until it has been tried `queue.max_attempts` times. With the defaults that's about 6 hours. After the last attempt it's marked `failed` and not tried again. Email queued while the notifier is stopped waits in the stream for up to `bus.streams.work_max_age`.

An email is sent at least once. If the notifier stops after the provider accepted an email but before recording it, the email is sent again when the job is redelivered. Once the delivery log says `sent`, it's never sent again.

## Delivery log

The `email_deliveries` table has one row per email, updated on each attempt:

| Column                 | Holds                                            |
| ---------------------- | ------------------------------------------------ |
| `id`                   | The delivery ID the sending service got back     |
| `template`, `locale`   | The template and the locale it was sent in       |
| `category`, `priority` | From the template                                |
| `recipient`, `user_id` | Who it was for. `user_id` is empty for non-users |
| `status`               | `retrying`, `sent` or `failed`                   |
| `attempts`             | How many times it has been tried                 |
| `provider`             | The provider used for the latest attempt         |
| `provider_message_id`  | The provider's ID, such as the SMTP `Message-ID` |
| `last_error`           | Why the latest attempt failed                    |
| `queued_at`, `sent_at` | When it was queued and accepted by the provider  |

Email bodies and variables are never stored or logged. Log lines carry the delivery ID, template and attempt, with the user ID hashed.

`retention.sweep` deletes entries older than `retention.delivery_logs`, except ones still being retried. A user's entries are included in their data export and deleted when the account is deleted.

## Metrics

| Metric                                 | Labels                           |
| -------------------------------------- | -------------------------------- |
| `qtiauth_email_deliveries_total`       | `provider`, `template`, `status` |
| `qtiauth_email_send_duration_seconds`  | `provider`, `outcome`            |
| `qtiauth_email_delivery_delay_seconds` | `priority`                       |

`qtiauth_email_deliveries_total` counts attempts by the status they left the email in, so an email that fails twice and then goes through counts two `retrying` and one `sent`. A send's `outcome` is `ok` or `error`. The delivery delay runs from queueing to the provider accepting the email, including retries.

The queues' consumer lag and redeliveries are in the bus metrics, under the consumers `notifier-work-email_high` and `notifier-work-email_normal` (see [bus.md](bus.md#metrics)).

Alert on any `failed` status, and on a delivery delay that keeps growing for `high`.

---

## For developers

### Sending email

```ts
import { queueEmail } from '@qtiauth/email';

const { delivery_id } = await queueEmail(ctx.bus, {
  template: 'magic_link',
  to: { address: email },
  locale: user.locale,
  userId: user.id,
  variables: { link, expires_in_minutes: 15 },
});
```

`variables` is typed from the template's definition. `queueEmail` checks them, the address and the locale before publishing, and throws `EmailRequestError` listing every problem, so a bad call fails in the service that made it. Leave `userId` out for someone without an account.

### Adding a template

1. Add it to `EMAIL_TEMPLATES` in `packages/email/src/templates.ts` with a description, category, priority and a zod object of its variables. Variables must be required strings, numbers or booleans, or objects of them.
2. Add `<name>.subject.txt`, `<name>.txt` and `<name>.mjml` to `services/notifier/templates/email/en-GB/`.
3. Add it to the template table above.

A unit test compiles every built-in template, so a missing file or variable fails `pnpm test`.

### Tests

`loadTemplates` takes the template directories, so templates can be tested from a temporary directory. `createEmailSender` takes the provider and the delivery log as plain objects, so it can be tested without NATS or Postgres. `startTestSmtpServer` from `services/notifier/src/testing.ts` runs a real SMTP server in the test process and collects what it receives.
