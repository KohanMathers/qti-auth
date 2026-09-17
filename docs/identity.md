# Identity

Identity owns accounts, sign-in and sessions. It always runs and uses the `identity` schema. So far it signs people up and in with magic links, and manages their sessions. The other sign-in methods, usernames, roles, legal documents and parental consent come in later releases (see [ROADMAP.md](../ROADMAP.md)).

## Settings

```yaml
accounts:
  max_per_email: 2
  email_normalization:
    gmail.com: { remove_dots: true, subaddress_separator: '+', domain: null }
    googlemail.com: { remove_dots: true, subaddress_separator: '+', domain: gmail.com }

magic_link:
  ttl: 15m
  signup_ttl: 30m

sessions:
  max_per_user: 10

cookies:
  session_ttl: 7d
  idle_timeout: 30d

age:
  bands: { 13_to_15: 13, 16_to_17: 16, adult: 18 }

parental:
  consent_age: 13

retention:
  sessions: 30d
  tokens: 24h
```

- `accounts.max_per_email` is how many accounts can share one email address, after normalization.
- `accounts.email_normalization` decides when two addresses count as the same, per domain. Case is always ignored. `remove_dots` ignores dots in the local part, `subaddress_separator` ignores everything from that character to the `@`, and `domain` counts the address as belonging to another domain. Setting it replaces the built-in Gmail rules, so copy them if you want to keep them.
- `magic_link.ttl` is how long a link works. `magic_link.signup_ttl` is how long a new user has to enter their date of birth after opening their link.
- `sessions.max_per_user` is how many sessions a user can have. Signing in again ends the oldest.
- `cookies.session_ttl` is the longest a session lasts, and `cookies.idle_timeout` ends it sooner if it isn't used.
- `age.bands` is the age in whole years each band starts at. Anyone younger than `13_to_15` is `under_13`.
- `parental.consent_age` is the age below which an account needs a parent or guardian's approval.
- `retention.sessions` is how long ended sessions are kept, and `retention.tokens` how long used or expired magic-link tokens are kept after they expire.
- `features.auth.magic_link.enabled: false` turns magic links off.

Identity also reads `branding`, `surfaces`, `cookies.domain`, `email.default_locale` and `features`. Links in emails point at the first origin of `surfaces.account`, so an account surface bound only to ports needs `origins`, and identity refuses to start without one.

## Accounts

Each account has one state:

| State                        | Meaning                                                 |
| ---------------------------- | ------------------------------------------------------- |
| `pending_email_verification` | The email address hasn't been confirmed yet             |
| `pending_parental_consent`   | Waiting for a parent or guardian to approve the account |
| `active`                     | Normal                                                  |
| `locked`                     | Temporarily locked by staff                             |
| `banned`                     | Banned by staff                                         |
| `pending_deletion`           | Will be deleted when its grace period ends              |
| `deleted`                    | Gone. Can't be signed in to                             |

Accounts only move between states along the allowed transitions in `ACCOUNT_TRANSITIONS`. Accounts created by magic link have a confirmed address, so they start `active`.

The date of birth is stored, and the age band is worked out from it whenever it's needed. Users younger than `parental.consent_age` can't sign up yet: signup answers `403 PARENTAL_CONSENT_UNAVAILABLE` and nothing is kept, until the guardian approval flow is available.

## Magic links

1. `POST /api/v1/auth/magic-link/start` with `{ email, locale?, return_to? }` always answers `202 { "status": "sent" }`, and always queues an email. Whether an account exists is only looked at when the link is used, so the answer can't give it away.
2. The link opens `/auth/magic-link?token=…` on the account surface. That page only shows a **Continue** button, so email scanners that fetch links don't use them up.
3. Continuing uses the link. With one account on the address, the user is signed in. With several, they choose one. With none, they're asked for their date of birth, and the account is created when they submit it.

Each link works once, for `magic_link.ttl`. The `magic_link` rate-limit policy applies to starting (3 an hour per address, 10 an hour and 20 a day per IP), and `auth_verify` to using links and signing up (30 every 15 minutes per IP).

The pages are deliberately plain: they're stand-ins until the web app arrives, and the same steps are available as JSON:

| Endpoint                                | Does                                                                                                                                          |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/v1/auth/magic-link/start`    | Emails a link                                                                                                                                 |
| `POST /api/v1/auth/magic-link/verify`   | Takes `{ token, user_id? }`. Answers `signed_in`, `choose_account` with the accounts to pick from, or `signup_required` with a `signup_token` |
| `POST /api/v1/auth/magic-link/signup`   | Takes `{ signup_token, date_of_birth }` and creates the account                                                                               |
| `GET /auth/magic-link`                  | The confirmation page                                                                                                                         |
| `POST /auth/magic-link`, `/auth/signup` | The form posts behind the pages                                                                                                               |

## Sessions

A session is a server-side record. The browser holds a random token in the session cookie, and identity stores only its SHA-256 hash, in a binding tied to the cookie's scope (`cookies.domain`, or the host). Signing in, signing out and ending sessions answer through the gateway, which sets or clears the cookie and drops the session from its cache before responding, so an ended session stops working on the very next request.

| Endpoint                              | Does                                                   |
| ------------------------------------- | ------------------------------------------------------ |
| `GET /api/v1/me`                      | The signed-in account and session                      |
| `POST /api/v1/auth/logout`            | Ends the current session. Works in every account state |
| `GET /api/v1/sessions`                | Active sessions, newest first, with `current` marked   |
| `DELETE /api/v1/sessions/:session_id` | Ends one session                                       |
| `POST /api/v1/sessions/revoke-others` | Ends every session but the current one                 |
| `POST /api/v1/sessions/revoke-all`    | Ends every session, including the current one          |

A session ends when it's `cookies.session_ttl` old, when it hasn't been used for `cookies.idle_timeout`, or when it's revoked. Activity is recorded at most once a minute.

Errors, on top of the [codes every service can return](services.md#errors):

| Code                           | Status | When                                                              |
| ------------------------------ | ------ | ----------------------------------------------------------------- |
| `MAGIC_LINK_INVALID`           | 400    | The link is unknown, has expired or has already been used         |
| `SIGNUP_TOKEN_INVALID`         | 400    | The signup token is unknown, has expired or has already been used |
| `AUTH_METHOD_DISABLED`         | 403    | `features.auth.magic_link.enabled` is `false`                     |
| `PARENTAL_CONSENT_UNAVAILABLE` | 403    | The user is younger than `parental.consent_age`                   |
| `ACCOUNT_NOT_FOUND`            | 404    | The signed-in account no longer exists                            |
| `SESSION_NOT_FOUND`            | 404    | No active session with that ID belongs to the user                |
| `ACCOUNT_LIMIT_REACHED`        | 409    | The address already has `accounts.max_per_email` accounts         |

## Events

| Event                                 | When                                                                                                     |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `qtiauth.identity.user.created.v1`    | An account was created                                                                                   |
| `qtiauth.identity.session.created.v1` | Someone signed in                                                                                        |
| `qtiauth.identity.session.revoked.v1` | A session was ended by signing out (`logout`), by the user (`revoked`) or by a newer sign-in (`evicted`) |

The gateway clears cached sessions when it sees `session.revoked`. Schemas are in `packages/events/schemas/identity/`.

## Retention and data rights

`retention.sweep` deletes sessions and their bindings `retention.sessions` after they ended, and magic-link and signup tokens `retention.tokens` after they expired.

A user's export has their account, sign-in methods, sessions and any tokens still kept for their address. Erasure deletes the account, its sign-in methods and sessions, and the tokens too unless another account uses the same address.

## Metrics

| Metric                                   | Labels               |
| ---------------------------------------- | -------------------- |
| `qtiauth_auth_magic_links_total`         | `event`              |
| `qtiauth_auth_sign_ins_total`            | `method`, `result`   |
| `qtiauth_auth_signups_total`             | `method`, `age_band` |
| `qtiauth_sessions_created_total`         | `method`             |
| `qtiauth_session_bindings_created_total` |                      |
| `qtiauth_sessions_revoked_total`         | `reason`             |
| `qtiauth_sessions_active`                |                      |
| `qtiauth_accounts`                       | `state`              |

Magic-link events are `sent`, `used`, `expired` (opened too late) and `invalid` (unknown or used already). A rise in `invalid` or failed sign-ins without a rise in `sent` suggests someone guessing. `qtiauth_sessions_active` and `qtiauth_accounts` are counted every minute.

Logs never contain tokens, email addresses or dates of birth. User IDs are hashed as usual.

---

## For developers

### How identity sets the cookie

Services never see cookies, so identity asks the gateway to set one with response headers. The gateway only honours them from identity, and strips them from every response:

| Header                       | Gateway does                                                             |
| ---------------------------- | ------------------------------------------------------------------------ |
| `X-QTIAuth-Session-Token`    | Sets the session cookie to this token                                    |
| `X-QTIAuth-Session-Expires`  | With the token: when the cookie expires (RFC 3339)                       |
| `X-QTIAuth-Session-Clear`    | Clears the session cookie                                                |
| `X-QTIAuth-Revoked-Sessions` | Comma-separated session IDs to drop from its session cache straight away |

The names are exported from `@qtiauth/service-kit`, and `sessionHeaders`, `revokedHeaders` and `signedOutHeaders` in `services/identity/src/headers.ts` build them.

### Tests

`captureEmails` from `services/identity/src/testing.ts` consumes the high-priority email queue as the notifier would, so tests can follow magic links without running the notifier. `gateway.integration.test.ts` runs the whole flow through a real gateway, using `gatewayService` from `@qtiauth/gateway/testing`.
