# Identity

Identity owns accounts, sign-in and sessions. It always runs and uses the `identity` schema. So far it signs people up and in with passwords, magic links, passkeys and upstream providers (Google, GitHub, Discord, Steam and generic OIDC), offers TOTP, recovery codes, step-up, email changes and session security, filters public text, lets people claim and change usernames, computes age bands with self-declared age assurance, assigns staff roles, stores the audit log, syncs legal documents that users accept at signup and again when a material version takes effect, lets staff search and act on accounts, and handles account deletion, data export, legal holds and the deletion ledger. Parental consent comes in a later release (see [ROADMAP.md](../ROADMAP.md)).

## Settings

```yaml
accounts:
  max_per_email: 2
  email_normalization:
    gmail.com: { remove_dots: true, subaddress_separator: '+', domain: null }
    googlemail.com: { remove_dots: true, subaddress_separator: '+', domain: gmail.com }
  email_change_ttl: 15m
  email_revert_ttl: 7d
  deletion_grace: 30d
  export_ttl: 7d
  export_email_max_bytes: 524288

magic_link:
  ttl: 15m
  signup_ttl: 30m

password:
  min_length: 10
  max_length: 256
  composition:
    require_lower: false
    require_upper: false
    require_digit: false
    require_symbol: false
  breach_check: true
  argon2: { memory_kib: 19456, iterations: 2, parallelism: 1 }
  reset_ttl: 15m
  verification_ttl: 15m
  failure_delay: { step: 250ms, max: 2s }

captcha:
  provider: altcha
  after: 3
  window: 15m

sessions:
  max_per_user: 10

session_security:
  on_country_change: challenge
  new_device_email: true
  tls_fingerprint: { header: null }
  alert_min_interval: 1h

geoip:
  source: dbip_lite
  header: null
  database_path: /var/lib/qtiauth/geoip/dbip-country-lite.csv.gz

text_filter:
  lists_dir: lists/username

cookies:
  session_ttl: 7d
  idle_timeout: 30d

age:
  bands: { 13_to_15: 13, 16_to_17: 16, adult: 18 }
  assurance: { default_provider: self_declared, required_for: [] }

parental:
  consent_age: 13

usernames:
  min_length: 8
  max_length: 18
  charset: '[A-Za-z0-9_]'
  reserved: []
  reserved_prefixes: []
  change_cooldown: 30d
  changes_per_year: 3
  change_window: 365d
  release_hold: 90d

legal:
  public_history: true
  documents_dir: legal

security:
  step_up_window: 10m
  encryption_key: '${env:APP_ENCRYPTION_KEY}'
  require_2fa_for_permissions:
    - users.*
    - safety.*
    - support.*
    - games.*
    - oidc.clients.*
    - webhooks.manage
    - audit.read
    - roles.manage
    - filter.*

roles:
  admin:
    name: Admin
    description: Full access, except permissions that must be granted by name.
    permissions: ['*']
  moderator:
    name: Moderator
    description: Moderate users, reports and the text filter.
    permissions:
      - users.read
      - users.ban
      - users.lock
      - users.edit_dob
      - users.force_username_reset
      - safety.reports.read
      - safety.actions.apply
      - filter.read
      - filter.manage
  support_agent:
    name: Support agent
    description: Handle support tickets.
    permissions: [users.read, support.tickets.staff]
  kb_editor:
    name: Knowledge-base editor
    description: Edit knowledge-base articles.
    permissions: [support.kb.edit]
  game_manager:
    name: Game manager
    description: Manage games, entitlements and keys.
    permissions: [games.catalog.edit, games.entitlements.grant, games.keys.manage]

retention:
  sessions: 30d
  tokens: 24h
  session_security_events: 90d
  filter_decisions: 30d
  audit: 730d

storage:
  enabled: false
  endpoint: ''
  region: us-east-1
  bucket: qtiauth
  access_key: '${env:S3_ACCESS_KEY}'
  secret_key: '${env:S3_SECRET_KEY}'
  force_path_style: true
  create_bucket: true
  presign_expires: 15m

backups:
  destination: directory
  directory: /var/lib/qtiauth/backups
  retention: 35d
```

- `accounts.max_per_email` is how many accounts can share one email address, after normalization.
- `accounts.email_normalization` decides when two addresses count as the same, per domain. Case is always ignored. `remove_dots` ignores dots in the local part, `subaddress_separator` ignores everything from that character to the `@`, and `domain` counts the address as belonging to another domain. Setting it replaces the built-in Gmail rules, so copy them if you want to keep them.
- `accounts.email_change_ttl` is how long the confirmation link sent to a new address works. `accounts.email_revert_ttl` is how long the “this wasn’t me” link sent to the previous address works.
- `accounts.deletion_grace` is how long an account stays in `pending_deletion` before it is erased. Signing in during that time cancels the deletion.
- `accounts.export_ttl` is how long a data-export download link works. `accounts.export_email_max_bytes` is the largest zip that can be emailed as an attachment when object storage is off.
- `storage` is the S3-compatible bucket (bundled MinIO or any external S3/R2/B2). It is off by default. Enable it and set `S3_ACCESS_KEY` and `S3_SECRET_KEY` for exports above the email limit, ticket attachments and cloud saves. Identity does not depend on MinIO starting.
- `backups.destination` is `directory` (the `backups` volume) or `storage` (the same bucket). The deletion ledger is written there through an outbox. Restore replay is a later release.
- `magic_link.ttl` is how long a link works. `magic_link.signup_ttl` is how long a new user has to enter their date of birth after opening their link.
- `password.min_length` and `password.max_length` bound a password. 256 characters is the hard cap. Composition rules are off unless you turn them on. `password.breach_check` asks Have I Been Pwned whether the password has appeared in a breach (only the first 5 hex characters of a SHA-1 hash leave the server); if HIBP is unreachable the check is skipped. `password.argon2` is Argon2id; stored hashes are rehashed on login when these change. `password.reset_ttl` and `password.verification_ttl` are how long reset and email-confirmation links work. `password.failure_delay` slows repeated failures per account and per IP. There is no lockout.
- `captcha.provider` is `altcha` (self-hosted proof-of-work, the default), `turnstile`, `hcaptcha`, `friendly_captcha` or `none`. `captcha.after` is how many failed password attempts, or signup or magic-link starts, from one IP it takes before a CAPTCHA is required. Attempts older than `captcha.window` do not count. `none` turns CAPTCHA off. Vendor providers need `site_key` and `secret_key`. Altcha can generate an HMAC key at startup; set `captcha.altcha.hmac_key` when running more than one identity replica.
- `sessions.max_per_user` is how many sessions a user can have. Signing in again ends the oldest.
- `session_security.on_country_change` is `challenge` (drop the session to `aal0` until the user signs in again), `block`, `notify` or `ignore`. `session_security.new_device_email` sends mail on a first sign-in from a browser or OS this account has not used. Accounts under 18 always get that email. `session_security.tls_fingerprint.header` is an optional request header such as JA4; `null` turns that signal off. `session_security.alert_min_interval` is the minimum gap between security-alert emails to the same user.
- `geoip.source` is `dbip_lite` (default), `maxmind`, `header` or `none`. `geoip.header` is required when source is `header`. `geoip.database_path` is a DB-IP Lite CSV (or gzipped CSV), or a MaxMind MMDB when source is `maxmind`.
- `text_filter.lists_dir` is the word-list directory, relative to the config file. Run `qtiauth lists update` to fill it.
- `cookies.session_ttl` is the longest a session lasts, and `cookies.idle_timeout` ends it sooner if it isn't used.
- `age.bands` is the age in whole years each band starts at. Anyone younger than `13_to_15` is `under_13`.
- `age.assurance.default_provider` is the provider used when a trigger in `age.assurance.required_for` applies. Only `self_declared` ships. `required_for` is empty by default; `claim_adult_band` records a second result when someone signs up in the adult band.
- `parental.consent_age` is the age below which an account needs a parent or guardian's approval.
- `usernames.min_length` and `usernames.max_length` bound a username. `usernames.charset` is the regex character class of allowed characters. Uniqueness is case-insensitive. `usernames.reserved` and `usernames.reserved_prefixes` are names and prefixes nobody can claim; both are empty by default and compared without regard to case. `usernames.change_cooldown` is how long after a claim or change the user must wait before changing again. `usernames.changes_per_year` is how many changes are allowed inside `usernames.change_window` after the first claim. `usernames.release_hold` is how long a released name is held for the previous owner.
- `legal.public_history` is whether previous versions are publicly viewable at `/legal/<id>/<version>`. The currently effective version is always public. `legal.documents_dir` is the markdown directory, relative to the config file. Identity syncs those files into the database on startup.
- `security.encryption_key` is a base64 32-byte key (`openssl rand -base64 32`) that encrypts TOTP secrets at rest. Identity will not start without it. Set `APP_ENCRYPTION_KEY` in `.env`.
- `security.step_up_window` is how recently a session must have reached `aal2` for a route that needs step-up, and for adding a password after a magic-link sign-in.
- `security.require_2fa_for_permissions` is the staff permissions that require a passkey or TOTP. Matching accounts can sign in but only reach enrolment until they set one up. A grant of `*` counts.
- `roles` are the built-in staff roles, keyed by slug. Identity seeds any missing slug on startup; after that they are edited in the admin API with `roles.manage`. `*` never matches permissions that must be granted by name, such as `safety.csea.access`.
- `retention.sessions` is how long ended sessions are kept, `retention.tokens` how long used or expired emailed tokens are kept after they expire, `retention.session_security_events` how long session security log rows are kept, `retention.filter_decisions` how long text-filter decisions (including the raw input) are kept, and `retention.audit` how long audit log rows are kept (oldest first, so the remaining chain still verifies).
- `features.auth.magic_link.enabled: false` turns magic links off. `features.auth.password.enabled: false` turns passwords off. `features.auth.passkeys.enabled: false` turns passkeys off. `features.auth.totp.enabled: false` turns authenticator-app sign-in off.
- `features.session_security.enabled: false` turns session security checks off.
- Each social provider is off until you enable it. Enabling Google, GitHub or Discord without `client_id` and `client_secret` fails config validation. Steam has no credentials. Generic OIDC providers are listed under `features.auth.social.generic_oidc`; their `id` must not collide with a built-in method.

Identity also reads `branding`, `surfaces`, `cookies.domain`, `email.default_locale`, `captcha`, `security`, `features`, `valkey`, `storage` and `backups`. Links in emails point at the first origin of `surfaces.account`, so an account surface bound only to ports needs `origins`, and identity refuses to start without one. Passkey origins are those same account origins. Session-binding codes live in Valkey for 60 seconds. When a social provider is enabled, OAuth `state`, PKCE verifiers and OIDC nonces live in Valkey for 10 minutes.

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

Accounts only move between states along the allowed transitions in `ACCOUNT_TRANSITIONS`. Accounts created by magic link have a confirmed address, so they start `active`. Accounts created with a password start `pending_email_verification` until the confirmation link is used. Social sign-up uses the provider’s verified email as-is when the provider says it is verified; otherwise the account stays `pending_email_verification` until our own confirmation link is used.

Changing email is `POST /api/v1/me/email` with `{ email }` and needs a recent `aal2` session. A confirmation link goes to the new address, and a notice goes to the current one with a 7-day revert link. `POST /api/v1/auth/email/change` applies the new address; `POST /api/v1/auth/email/revert` switches it back.

A user can’t remove their last sign-in method. Magic link (when enabled), password, passkeys and connected social identities all count. Trying to remove the last one answers `409 LAST_SIGN_IN_METHOD` with the spec’s warning and `delete_account_path: "/account/delete"`.

The date of birth is stored, and the age band is worked out from it whenever it's needed. Users cannot edit their own date of birth after signup. Staff with `users.edit_dob` can change it, with a reason that is stored. Users younger than `parental.consent_age` can't sign up yet: signup answers `403 PARENTAL_CONSENT_UNAVAILABLE` and nothing is kept, until the guardian approval flow is available.

`GET /api/v1/me` includes `deletion_requested_at`, which is set while the account is `pending_deletion`.

Deleting an account is `POST /api/v1/me/deletion` and needs a recent `aal2` session. The account moves to `pending_deletion` for `accounts.deletion_grace`, every session ends, and signing in during that time returns it to `active`. `accounts.purge_deleted` then emits `identity.user.deleted` and every service erases the user, including objects in storage. A `{ user_id, deleted_at }` ledger entry is written to the backup destination through an outbox and kept for `backups.retention` plus 30 days (`deletion_ledger.prune`). Safety can place a legal hold over RPC (`place_legal_hold`); held objects stay isolated under `legal-hold/` when everything else is deleted.

A copy of the account's data is `POST /api/v1/me/export`, also after step-up. Identity zips its own export with `export_user` answers from notifier, oidc, games, safety and support (a service that isn't running is skipped). With storage, a download link is emailed for `accounts.export_ttl`. Without storage, the zip is emailed as an attachment when it is under `accounts.export_email_max_bytes`; otherwise the export is `unavailable` and `GET /api/v1/meta/health` reports `STORAGE_UNAVAILABLE`. `GET /api/v1/me/export/:export_id` is the status, including a fresh presigned URL while the object is still there. `GET`/`POST /auth/delete` and `/auth/export` are the interim pages.

| Endpoint                           | Does                                                                        |
| ---------------------------------- | --------------------------------------------------------------------------- |
| `POST /api/v1/me/deletion`         | Schedule deletion. Needs step-up. Signs the caller out                      |
| `POST /api/v1/me/export`           | Start a data export. Needs step-up. Answers `202 { id, status: "pending" }` |
| `GET /api/v1/me/export/:export_id` | Export status, download URL when ready, or `unavailable`                    |
| `GET`/`POST /auth/delete`          | Interim deletion page                                                       |
| `GET`/`POST /auth/export`          | Interim export page                                                         |

`docker compose run --rm identity qtiauth user export <user-id>` prints identity's export JSON. `qtiauth user delete <user-id>` schedules deletion as the system actor.

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
| `GET /auth/signup`                      | Choose password or magic-link signup                                                                                                          |
| `GET /auth/magic-link/start`            | Ask for a magic link                                                                                                                          |

## Passwords

Signup is `POST /api/v1/auth/password/signup` with `{ email, password, date_of_birth, locale? }`. The account is created in `pending_email_verification` and a confirmation email is sent. The account becomes `active` when `POST /api/v1/auth/email/verify` is used. Login is allowed before that; `/api/v1/me` shows the pending state.

Login is `POST /api/v1/auth/password/login` with `{ email, password }`. Unknown addresses and wrong passwords both answer `401 CREDENTIALS_INCORRECT` ("Email or password incorrect") after an Argon2id check and the same progressive delay, so timing does not give the address away. If the account has a second factor enrolled — TOTP or a passkey — the answer is `200 { "status": "second_factor_required", "challenge", "methods", "expires_at" }` instead of a session, and sign-in finishes at `/api/v1/auth/2fa` or with a passkey.

Forgot password is `POST /api/v1/auth/password/forgot` with `{ email }`, always `202 { "status": "sent" }`. The reset form has a **"Don't log me out of other sessions"** checkbox, **unticked by default**, so `POST /api/v1/auth/password/reset` revokes every other session unless `keep_other_sessions` is true.

Adding a password to a passwordless account is `POST /api/v1/me/password` with `{ password }` after a magic-link sign-in within `security.step_up_window`. Changing one takes `{ password, current_password }`.

Passwords equal to or containing the email local part (3 or more characters) are rejected. Hashes are Argon2id PHC strings in `identities.secret`.

| Endpoint                               | Does                                                        |
| -------------------------------------- | ----------------------------------------------------------- |
| `POST /api/v1/auth/password/signup`    | Create an account; emails a confirmation link               |
| `POST /api/v1/auth/password/login`     | Sign in                                                     |
| `POST /api/v1/auth/password/forgot`    | Email a reset link                                          |
| `POST /api/v1/auth/password/reset`     | Takes `{ token, password, keep_other_sessions?, user_id? }` |
| `POST /api/v1/auth/email/verify/start` | Email a confirmation link for a pending address             |
| `POST /api/v1/auth/email/verify`       | Confirm the address and sign in                             |
| `POST /api/v1/me/password`             | Add or change a password                                    |
| `GET`/`POST /auth/register`            | Password signup pages                                       |
| `GET`/`POST /auth/login`               | Password sign-in pages                                      |
| `GET`/`POST /auth/forgot-password`     | Request a reset                                             |
| `GET`/`POST /auth/reset-password`      | Scanner-safe confirm, then the reset form                   |
| `GET`/`POST /auth/verify-email`        | Scanner-safe confirm                                        |
| `POST /api/v1/me/email`                | Start an email change. Needs `step_up: true`                |
| `POST /api/v1/auth/email/change`       | Confirm the new address from the emailed link               |
| `POST /api/v1/auth/email/revert`       | Undo a change from the notice sent to the previous address  |
| `GET`/`POST /auth/change-email`        | Scanner-safe confirm                                        |
| `GET`/`POST /auth/revert-email`        | Scanner-safe undo                                           |

## Social and upstream sign-in

Google, GitHub, Discord, Steam (OpenID 2.0) and generic OIDC issuers can be used to sign in or to connect to an existing account. Connecting only happens when the user is signed in and chooses **Connect …**. Matching emails never link accounts.

`state`, PKCE (S256) and OIDC `nonce` are stored in Valkey for 10 minutes. Starting a flow also sets a 10-minute flow cookie, and the flow only finishes in the browser that holds it, so nobody can finish their own flow in someone else's browser. Connecting also has to finish in the same session that started it. `return_to` must be a path on the account surface. Only verified provider emails are trusted: Google and generic OIDC use `email_verified`, GitHub uses a verified primary address from `/user/emails`, Discord uses `verified` on the user, and Steam provides no email. An unverified or missing address is collected at signup and confirmed with our own email.

| Endpoint                                       | Does                                                                                           |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `POST /api/v1/auth/social/:provider/start`     | Returns the provider URL. `provider` is `google`, `github`, `discord`, `steam` or a generic id |
| `POST /api/v1/auth/social/complete`            | Finish after the provider redirects back. May answer `signup_required`                         |
| `POST /api/v1/auth/social/signup`              | `{ challenge, date_of_birth?, email? }` when the provider did not supply both                  |
| `POST /api/v1/me/identities/:provider/connect` | Start connecting while signed in                                                               |
| `GET /api/v1/me/identities`                    | Connected providers and which ones can still be added                                          |
| `DELETE /api/v1/me/identities/:identity_id`    | Remove a connected provider, unless it is the last sign-in method                              |
| `GET /auth/social/:provider/start`             | Redirect to the provider                                                                       |
| `GET /auth/social/:provider/callback`          | Finish after the redirect                                                                      |
| `GET`/`POST /auth/social/signup`               | Date of birth / email after upstream sign-in                                                   |
| `GET /auth/identities`                         | Connected methods and Connect links                                                            |
| `GET /auth/identities/:provider/connect`       | Redirect to the provider while signed in                                                       |

## Passkeys and two-factor

Passkeys (WebAuthn) work as a primary sign-in or as a second factor. Several can be registered, each with a name and last-used time. A passkey-only sign-in creates a session at `aal2`. Password sign-in is `aal1` unless a second factor is enrolled — TOTP or a passkey — in which case a second factor is required and the resulting session is `aal2`. The same set counts for `security.require_2fa_for_permissions`, so enrolment and the sign-in challenge always agree.

TOTP is RFC 6238 (SHA-1, 6 digits, 30-second step, ±1 window). The secret is encrypted at rest with `security.encryption_key`. Confirming enrolment issues 10 hashed single-use recovery codes, which can be replaced at `POST /api/v1/me/recovery-codes` after a recent step-up.

Staff whose permissions match `security.require_2fa_for_permissions` can sign in without a second factor, but the gateway only lets them hit routes with `allow_pending_2fa_enrolment: true` (enrolment and sign-out) until they register a passkey or TOTP. A grant of `*` matches those patterns.

| Endpoint                                       | Does                                                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `POST /api/v1/auth/passkey/authenticate/start` | WebAuthn options. Pass `second_factor` after a password sign-in that needs a second factor |
| `POST /api/v1/auth/passkey/authenticate`       | Finish passkey sign-in                                                                     |
| `POST /api/v1/auth/2fa`                        | Finish password sign-in with `{ challenge, totp }` or `{ challenge, recovery_code }`       |
| `GET /api/v1/me/factors`                       | Whether TOTP, recovery codes and passkeys are set up                                       |
| `GET /api/v1/me/passkeys`                      | Named passkeys                                                                             |
| `POST /api/v1/me/passkeys/register/start`      | WebAuthn creation options                                                                  |
| `POST /api/v1/me/passkeys/register`            | `{ challenge, name, response }`                                                            |
| `POST /api/v1/me/passkeys/:passkey_id`         | Rename                                                                                     |
| `DELETE /api/v1/me/passkeys/:passkey_id`       | Remove, unless it is the last sign-in method                                               |
| `POST /api/v1/me/totp/start`                   | `otpauth` URI, secret and challenge                                                        |
| `POST /api/v1/me/totp`                         | Confirm with `{ challenge, code }`. Returns recovery codes                                 |
| `POST /api/v1/me/totp/disable`                 | Turn TOTP off with a current code                                                          |
| `POST /api/v1/me/recovery-codes`               | Replace recovery codes. Needs `step_up: true`                                              |
| `POST /api/v1/me/step-up`                      | Raise this session to `aal2` with TOTP or a recovery code                                  |
| `POST /api/v1/me/step-up/passkey/start`        | WebAuthn options to step up                                                                |
| `POST /api/v1/me/step-up/passkey`              | Finish passkey step-up                                                                     |
| `GET`/`POST /auth/two-factor`                  | Interim authenticator/recovery form after password sign-in                                 |
| `GET`/`POST /auth/totp`                        | Interim authenticator enrolment                                                            |
| `GET /auth/passkey`                            | Interim passkey sign-in page                                                               |
| `GET /auth/passkeys`                           | Interim passkey list                                                                       |
| `GET /auth/bind`                               | Issue a one-time code that binds this session to another surface                           |
| `GET /auth/bind/callback`                      | Exchange the code and set this host’s session cookie                                       |

## CAPTCHA

Signup, password login and magic-link start show a CAPTCHA only after `captcha.after` attempts from the same IP inside `captcha.window`. Until then the request is processed as usual. After the threshold the request is refused with `403 CAPTCHA_REQUIRED` until a valid solution is sent in `captcha`. A bad solution is `400 CAPTCHA_INVALID`. `GET /api/v1/captcha?action=password_login|password_signup|magic_link` says whether this IP currently needs one, and returns an Altcha challenge or the vendor site key.

The interim login, register and magic-link start pages redisplay the form with the widget when a CAPTCHA is required.

## Sessions

A session is a server-side record. The browser holds a random token in the session cookie, and identity stores only its SHA-256 hash, in a binding tied to the cookie's scope (`cookies.domain`, or the host). Each host that cannot share that cookie gets its own binding for the **same** session. Signing in, signing out and ending sessions answer through the gateway, which sets or clears the cookie and drops the session from its cache before responding, so an ended session stops working on the very next request.

When a browser navigation needs a session on a host that has no binding, the gateway redirects to `/auth/bind` on the account surface. If the user is signed in there, identity issues a single-use code (60 seconds, bound to the target origin and return path) and redirects to `/auth/bind/callback` on the target surface, which sets that host's cookie for the same session. If they are not signed in, `/auth/bind` lands on `/auth/login` and continues after sign-in. A short-lived `qtiauth_session_bound` cookie stops a failed bind from redirecting forever. Logging out or revoking a session invalidates every binding.

| Endpoint                              | Does                                                   |
| ------------------------------------- | ------------------------------------------------------ |
| `GET /api/v1/me`                      | The signed-in account and session                      |
| `POST /api/v1/auth/logout`            | Ends the current session. Works in every account state |
| `GET /api/v1/sessions`                | Active sessions, newest first, with `current` marked   |
| `DELETE /api/v1/sessions/:session_id` | Ends one session                                       |
| `POST /api/v1/sessions/revoke-others` | Ends every session but the current one                 |
| `POST /api/v1/sessions/revoke-all`    | Ends every session, including the current one          |

A session ends when it's `cookies.session_ttl` old, when it hasn't been used for `cookies.idle_timeout`, or when it's revoked. Activity is recorded at most once a minute.

`GET /api/v1/sessions` includes `device` (browser and OS from the user agent) and `country` (ISO code from GeoIP).

### Session security

`features.session_security.enabled` (on by default) scores each request against the signals captured at sign-in: IP, subnet (/24 IPv4, /48 IPv6), country, User-Agent, and optionally a TLS fingerprint header plus low-weight client timezone, screen and fingerprint headers (`X-QTIAuth-Timezone`, `X-QTIAuth-Screen`, `X-QTIAuth-Client-Fingerprint`). Trust moves `full` → `partial` → `challenge` → `blocked`. Only the signals present on both sides count, and the weak ones cannot challenge or end a session by themselves: with less than a country's worth of weight to compare, the worst verdict is `partial`, so a client that only reports a new timezone or screen size is never signed out. The gateway caches a resolved session per subnet rather than per address, so an IP that changes within its subnet reuses the cached session while a move to another subnet or country is checked again.

`session_security.on_country_change` decides what happens when the country changes:

| Policy      | Effect                                                             |
| ----------- | ------------------------------------------------------------------ |
| `challenge` | Default. The session drops to `aal0` until the user signs in again |
| `block`     | The session is ended and a security-alert email is sent            |
| `notify`    | The session continues, and a security-alert email is sent          |
| `ignore`    | Nothing                                                            |

Re-authentication after `aal0` uses a magic link, a passkey, or password plus 2FA, and restores the **same** session rather than minting a new cookie. Social sign-in always starts a new session. Routes that need a session refuse `aal0` with `403 REAUTHENTICATION_REQUIRED`, except `POST /api/v1/auth/logout` (`allow_aal0: true`). A top-level navigation in that state is sent to `/auth/login`.

A first sign-in from a browser or OS that this account has not used sends a `new_device` email, unless `session_security.new_device_email` is false. Accounts under 18 always get that email. Security-alert emails are at most one per user per `session_security.alert_min_interval`.

GeoIP defaults to DB-IP Lite (CC-BY 4.0) at `geoip.database_path`. Set `geoip.source` to `maxmind`, `header` (with `geoip.header`) or `none`. Country checks switch off when no country can be resolved. Attribution is on `GET /about` and `GET /api/v1/meta/about`.

### Text filter

Identity loads the word lists in `text_filter.lists_dir` and filters public text with the pipeline in [SPEC §4.11](../SPEC.md#411-text-filter-core-library): allowlist, exact block, dictionary (this is what saves Scunthorpe), then tokens and padded B_loose matches. It never find-and-replaces, never substring-matches B_exact, and never maps `1` to `i`. Every decision is stored in `filter_decisions`.

`qtiauth lists update [--ldnoobw <commit>]` vendors every LDNOOBW language file at a pinned commit (spaces stripped; `tlh` omitted), SCOWL size 70, ONS and US SSA given names, US Census surnames, and GeoNames places. `qtiauth lists audit` prints dictionary words that contain a blocked substring.

| Method                                        | What it does                     |
| --------------------------------------------- | -------------------------------- |
| `GET /api/v1/admin/filter/blocks`             | Recent blocks, newest first      |
| `GET /api/v1/admin/filter/unknowns`           | Recent unknowns, newest first    |
| `GET /api/v1/admin/filter/allowlist`          | File and admin allowlist entries |
| `POST /api/v1/admin/filter/allowlist`         | Add an admin allowlist word      |
| `DELETE /api/v1/admin/filter/allowlist/:word` | Remove an admin allowlist word   |
| `GET /api/v1/admin/filter/blocklist`          | Extra blocklist (file and admin) |
| `POST /api/v1/admin/filter/blocklist`         | Add an extra-block word          |
| `DELETE /api/v1/admin/filter/blocklist/:word` | Remove an admin extra-block word |

`filter.read` is needed to view those lists; `filter.manage` to change them. File entries in `allow.txt` and `extra-block.txt` cannot be deleted through the API.

## Usernames

Accounts can exist without a username. `POST /api/v1/me/username` with `{ username }` claims one, or changes it later. The first claim is free of the cooldown and yearly limit. Changing is limited by `usernames.change_cooldown` and `usernames.changes_per_year`. History is kept. Changing a name holds the old one for `usernames.release_hold`; during the hold **only the previous owner** can reclaim it.

Every candidate goes through the text filter. Taken names, reserved names, reserved prefixes and filter blocks all answer `409 USERNAME_UNAVAILABLE` ("Username not available"). Length and charset failures are `400 USERNAME_INVALID`.

`GET /api/v1/me` includes `username`, `username_updated_at` and `username_reset_required`. Username and `username_updated_at` are null until a name is claimed. It also includes `public_profile` and `leaderboard_visible`. Staff can force a reset: the current name is released, `username_reset_required` is true, and the next claim skips cooldown and the yearly limit. `GET`/`POST /auth/username` is the interim page.

| Endpoint                    | Does                                      |
| --------------------------- | ----------------------------------------- |
| `POST /api/v1/me/username`  | Claim or change the signed-in user’s name |
| `GET`/`POST /auth/username` | Interim claim/change form                 |

## Age

Age band is computed from the stored date of birth, never stored as a flag: `under_13`, `13_to_15`, `16_to_17`, `adult`. Login and `GET /api/v1/me` derive it on the spot. `age.recompute_bands` (daily 00:05) finds users whose birthday means they crossed a band boundary and publishes `identity.user.age_band_changed`, so other services see the change without the user signing in.

Signup records a `self_declared` age-assurance result. Identity ships no other provider. `age.assurance.required_for: [claim_adult_band]` records a second result when the claimed band is `adult`. Results store provider, strength, trigger, timestamp and an optional vendor reference, never identity documents.

Accounts under 18 start with public profile and leaderboard visibility off, and always receive new-device emails even if `session_security.new_device_email` is false. Crossing 18 leaves those settings as they are.

Staff change a date of birth at `POST /api/v1/admin/users/:user_id/date-of-birth` with `{ date_of_birth, reason }`. That needs `users.edit_dob` and a recent step-up. Making someone under 18 turns public profile and leaderboards off.

## Admin users

Staff with `users.read` search accounts at `GET /api/v1/admin/users` (Postgres full-text on username and email, filters on `state`, `age_band`, `role_id` and created date) and load detail at `GET /api/v1/admin/users/:user_id`. Detail is assembled on the bus: identity fills profile, sign-in methods (never secrets), sessions, security events, username history, staff actions and an empty guardians list. Optional services answer `qtiauth.rpc.safety.user_moderation`, `qtiauth.rpc.games.user_entitlements` and `qtiauth.rpc.support.user_tickets` with `{ user_id }`; those sections are omitted when the service is not running.

Each action needs a `reason` and a recent step-up, and is audited. Staff cannot run them on their own account.

| Endpoint                                            | Permission                   | Does                                                                                                                      |
| --------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/admin/users`                           | `users.read`                 | Search and filter                                                                                                         |
| `GET /api/v1/admin/users/:user_id`                  | `users.read`                 | Assembled detail                                                                                                          |
| `POST /api/v1/admin/users/:user_id/ban`             | `users.ban`                  | Ban. Sessions stay, so appeals and data rights still work                                                                 |
| `POST /api/v1/admin/users/:user_id/unban`           | `users.ban`                  | Lift a ban                                                                                                                |
| `POST /api/v1/admin/users/:user_id/lock`            | `users.lock`                 | Lock until `expires_at`. `accounts.unlock_expired` (every minute) lifts it, as does the next session resolve after expiry |
| `POST /api/v1/admin/users/:user_id/unlock`          | `users.lock`                 | Lift a lock                                                                                                               |
| `POST /api/v1/admin/users/:user_id/reauth`          | `users.lock`                 | Drop every session to `aal0`                                                                                              |
| `POST /api/v1/admin/users/:user_id/sessions/revoke` | `users.lock`                 | End every session                                                                                                         |
| `POST /api/v1/admin/users/:user_id/username-reset`  | `users.force_username_reset` | Release the current username. The user picks a new one, skipping cooldown                                                 |
| `POST /api/v1/admin/users/:user_id/date-of-birth`   | `users.edit_dob`             | Staff-only date-of-birth change, with a reason                                                                            |

## Roles

Permissions are declared by each running service in its route manifest. Identity listens for those announcements and serves the current registry at `GET /api/v1/admin/permissions`. A service that is not running has no permissions. `safety.csea.access` is declared with `wildcard: false`, so a grant of `*` or `safety.*` does not cover it.

Roles are seeded from `roles` in config on startup (`admin`, `moderator`, `support_agent`, `kb_editor`, `game_manager`). After that they live in the database and are edited with `roles.manage`. Built-in roles cannot be deleted. Users are assigned roles; the session and internal identity token carry the union of those grants.

The first admin is created with `docker compose run --rm identity qtiauth admin create --email …`. That prints a one-time magic-link URL. It refuses if anyone already has the admin role. There are no default credentials.

`GET /api/v1/me` includes `roles` and `permissions` (the grants, including wildcards). Role and membership changes publish `qtiauth.audit.recorded.v1`.

| Endpoint                                 | Does                                                            |
| ---------------------------------------- | --------------------------------------------------------------- |
| `GET /api/v1/admin/permissions`          | Permissions declared by running services                        |
| `GET /api/v1/admin/roles`                | All roles, with stored grants and current effective permissions |
| `POST /api/v1/admin/roles`               | Create a custom role. Needs step-up                             |
| `GET /api/v1/admin/roles/:role_id`       | One role                                                        |
| `PATCH /api/v1/admin/roles/:role_id`     | Edit name, description or grants. Needs step-up                 |
| `DELETE /api/v1/admin/roles/:role_id`    | Delete a custom role. Needs step-up                             |
| `GET /api/v1/admin/users/:user_id/roles` | Roles assigned to a user                                        |
| `PUT /api/v1/admin/users/:user_id/roles` | Replace a user’s roles. Needs step-up                           |

## Audit

Services publish `qtiauth.audit.recorded.v1` for staff actions, security-sensitive user actions (password, 2FA, email) and administrative changes (roles, text-filter lists). Identity stores each event as an append-only row with a hash of the previous row. `database.audit` is an extra Postgres role with `INSERT` and `SELECT` only on `identity.audit_log`. Identity’s own role cannot `UPDATE` or `TRUNCATE` that table.

`GET /api/v1/admin/audit` lists rows, newest first, filterable by `actor_id`, `actor_type`, `action`, `target_type`, `target_id`, `from` and `to`. It needs `audit.read`. `docker compose run --rm identity qtiauth audit verify` walks the chain and names the first row that does not match.

| Endpoint                  | Does                                                   |
| ------------------------- | ------------------------------------------------------ |
| `GET /api/v1/admin/audit` | Filter the audit log by actor, action, target and date |

## Legal documents

Terms, privacy and any other documents live in `config/legal/*.md` with YAML front-matter (`id`, `version`, `effective_at`, `material`, `summary`) and a markdown body. `{{ brand.product_name }}`, `{{ brand.company_name }}` and `{{ brand.support_email }}` are filled in when a document is shown. The stored hash is of the raw body.

On startup identity syncs each file into `legal_versions`. Versions are immutable: changing a body, summary, `material` flag or `effective_at` without bumping `version` is a startup error. `legal.publish` (every minute) marks versions whose `effective_at` has passed, publishes `identity.legal.version_published`, and for a non-material change queues a `legal_update` email. Signup records acceptance of every currently effective version (`method: signup`), so a new account is not gated. A later material version sets `legal_acceptance_required` on the session; the gateway answers `403 LEGAL_ACCEPTANCE_REQUIRED` on every route except those with `allow_pending_legal: true`. `POST /api/v1/me/legal/accept` and `POST /legal/accept` record `method: self` and lift the gate. Under-18 accounts accept themselves until guardian acceptance in Phase 3. `children-summary` is a normal document.

| Endpoint                         | Does                                                                                    |
| -------------------------------- | --------------------------------------------------------------------------------------- |
| `GET /api/v1/legal`              | Currently effective documents, without bodies                                           |
| `GET /api/v1/legal/:id`          | The currently effective version of one document                                         |
| `GET /api/v1/legal/:id/:version` | A specific version. Previous versions need `legal.public_history`                       |
| `GET /api/v1/me/legal`           | Pending material versions and this account’s acceptances. Allowed during the legal gate |
| `POST /api/v1/me/legal/accept`   | Accept versions. Allowed during the legal gate                                          |
| `GET /legal`                     | HTML index of current documents                                                         |
| `GET /legal/:id`                 | HTML for the current version                                                            |
| `GET /legal/:id/:version`        | HTML for a specific version                                                             |
| `GET`/`POST /legal/accept`       | HTML form that accepts every pending material version                                   |

Errors, on top of the [codes every service can return](services.md#errors):

| Code                           | Status | When                                                                                   |
| ------------------------------ | ------ | -------------------------------------------------------------------------------------- |
| `MAGIC_LINK_INVALID`           | 400    | The link is unknown, has expired or has already been used                              |
| `SIGNUP_TOKEN_INVALID`         | 400    | The signup token is unknown, has expired or has already been used                      |
| `PASSWORD_REJECTED`            | 400    | The password fails length, composition, containment or HIBP                            |
| `RESET_TOKEN_INVALID`          | 400    | The reset link is unknown, has expired or has already been used                        |
| `EMAIL_VERIFICATION_INVALID`   | 400    | The confirmation link is unknown, has expired or has already been used                 |
| `CURRENT_PASSWORD_REQUIRED`    | 400    | Changing a password without the current one                                            |
| `CURRENT_PASSWORD_INCORRECT`   | 400    | The current password does not match                                                    |
| `CHALLENGE_INVALID`            | 400    | The challenge is unknown, has expired or has already been used                         |
| `PASSKEY_INVALID`              | 400    | The passkey could not be verified                                                      |
| `TOTP_INVALID`                 | 400    | The authenticator code is incorrect                                                    |
| `TOTP_NOT_ENABLED`             | 400    | Authenticator-app sign-in is not set up                                                |
| `RECOVERY_CODE_INVALID`        | 400    | The recovery code is incorrect or has been used                                        |
| `OAUTH_FAILED`                 | 400    | The upstream callback was missing, denied, expired or already used                     |
| `EMAIL_UNCHANGED`              | 400    | The new address is already this account’s email                                        |
| `EMAIL_CHANGE_INVALID`         | 400    | The email change link is unknown, has expired or has already been used                 |
| `EMAIL_REVERT_INVALID`         | 400    | The email revert link is unknown, has expired or has already been used                 |
| `CAPTCHA_INVALID`              | 400    | A CAPTCHA was required and the solution was wrong                                      |
| `USERNAME_INVALID`             | 400    | The username fails length or character-set rules                                       |
| `USERNAME_UNCHANGED`           | 400    | The username is already this account’s                                                 |
| `DATE_OF_BIRTH_INVALID`        | 400    | The date of birth is not a real past date                                              |
| `DATE_OF_BIRTH_UNCHANGED`      | 400    | The date of birth is already this account’s                                            |
| `LOCK_EXPIRY_INVALID`          | 400    | The lock expiry must be in the future                                                  |
| `CREDENTIALS_INCORRECT`        | 401    | Email or password incorrect                                                            |
| `AUTH_METHOD_DISABLED`         | 403    | `features.auth.magic_link`, `password`, `passkeys`, `totp` or a social provider is off |
| `STEP_UP_REQUIRED`             | 403    | A route that needs a recent `aal2` session, or adding a password without one           |
| `CAPTCHA_REQUIRED`             | 403    | This IP is over the CAPTCHA threshold and no valid solution was sent                   |
| `PARENTAL_CONSENT_UNAVAILABLE` | 403    | The user is younger than `parental.consent_age`                                        |
| `ACCOUNT_NOT_FOUND`            | 404    | The signed-in account no longer exists, or staff asked for an account that does not    |
| `SESSION_NOT_FOUND`            | 404    | No active session with that ID belongs to the user                                     |
| `PASSKEY_NOT_FOUND`            | 404    | No passkey with that ID belongs to the user                                            |
| `IDENTITY_NOT_FOUND`           | 404    | No connected social identity with that ID belongs to the user                          |
| `FILTER_ENTRY_NOT_FOUND`       | 404    | No admin-added allowlist or extra-block word with that value                           |
| `ROLE_NOT_FOUND`               | 404    | No role with that ID                                                                   |
| `LEGAL_DOCUMENT_NOT_FOUND`     | 404    | No such legal document, or that version is not public                                  |
| `EXPORT_NOT_FOUND`             | 404    | No data export with that id belongs to the user                                        |
| `USERNAME_UNAVAILABLE`         | 409    | The username is taken, reserved, held or blocked by the text filter                    |
| `USERNAME_COOLDOWN`            | 409    | `usernames.change_cooldown` has not elapsed since the last claim or change             |
| `USERNAME_CHANGE_LIMIT`        | 409    | `usernames.changes_per_year` changes have already been used in `change_window`         |
| `ACCOUNT_LIMIT_REACHED`        | 409    | The address already has `accounts.max_per_email` accounts                              |
| `ACCOUNT_SELF`                 | 409    | Staff tried to ban, lock, or otherwise act on their own account                        |
| `ACCOUNT_STATE_CONFLICT`       | 409    | The account is not in a state that allows that staff action                            |
| `DELETION_NOT_PENDING`         | 409    | The account is not waiting to be deleted                                               |
| `TOTP_ALREADY_ENABLED`         | 409    | Authenticator-app sign-in is already set up                                            |
| `IDENTITY_IN_USE`              | 409    | That provider identity is already connected to another account                         |
| `LAST_SIGN_IN_METHOD`          | 409    | Removing this method would leave the account with no sign-in method                    |
| `ROLE_SLUG_TAKEN`              | 409    | A role with this slug already exists                                                   |
| `ROLE_BUILTIN`                 | 409    | Built-in roles cannot be deleted                                                       |
| `PROVIDER_UNAVAILABLE`         | 502    | The upstream provider did not complete token exchange or userinfo                      |
| `EXPORT_UNAVAILABLE`           | 503    | A data export cannot be delivered without object storage                               |

## Events

| Event                                         | When                                                                                                                                      |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `qtiauth.identity.user.created.v1`            | An account was created                                                                                                                    |
| `qtiauth.identity.user.updated.v1`            | An account field changed. `fields` names what changed (`username`, `date_of_birth`, `roles`, `legal`, `state`)                            |
| `qtiauth.identity.user.deleted.v1`            | The deletion grace period ended. Every service must erase this user. `held` is true when a legal hold kept isolated copies                |
| `qtiauth.identity.user.banned.v1`             | Staff banned an account. Sessions stay. The gateway drops cached sessions for the user                                                    |
| `qtiauth.identity.user.unbanned.v1`           | Staff lifted a ban                                                                                                                        |
| `qtiauth.identity.user.locked.v1`             | Staff locked an account until `expires_at`                                                                                                |
| `qtiauth.identity.user.unlocked.v1`           | A lock ended, by staff or because it expired                                                                                              |
| `qtiauth.identity.user.age_band_changed.v1`   | The computed age band changed, usually because they had a birthday                                                                        |
| `qtiauth.identity.session.created.v1`         | Someone signed in                                                                                                                         |
| `qtiauth.identity.session.revoked.v1`         | A session was ended by signing out (`logout`), by the user (`revoked`), by a newer sign-in (`evicted`) or by session security (`blocked`) |
| `qtiauth.identity.session.flagged.v1`         | A session dropped to `aal0`: country change, other trust signals, or staff forcing re-authentication                                      |
| `qtiauth.identity.legal.version_published.v1` | A legal document version took effect. The gateway drops every cached session. Non-material versions also queue a `legal_update` email     |
| `qtiauth.audit.recorded.v1`                   | A staff or security-sensitive action. Identity stores these in the audit log                                                              |

The gateway clears cached sessions when it sees `session.revoked`, `session.flagged`, `user.updated`, `user.banned`, `user.unbanned`, `user.locked`, `user.unlocked`, `user.deleted` or `user.age_band_changed`, and every cached session when it sees `legal.version_published`. Accepting a legal version publishes `user.updated` with `fields: ["legal"]` so the gate lifts without waiting for the cache TTL. Schemas are in `packages/events/schemas/identity/` and `packages/events/schemas/audit/`.

## Retention and data rights

`retention.sweep` deletes sessions and their bindings `retention.sessions` after they ended, emailed tokens and auth challenges `retention.tokens` after they expired, auth-failure counters `retention.tokens` after they were last updated, session security events `retention.session_security_events` after they were recorded, text-filter decisions `retention.filter_decisions` after they were recorded, and the oldest audit log rows `retention.audit` after they were recorded.

A user's export has their account (including username, public profile, leaderboard visibility, security-notification flag, lock expiry, whether a username reset is required and `deletion_requested_at`), username history, age-assurance results, staff date-of-birth changes, staff account actions, assigned roles, audit rows where they are the actor or the target, legal acceptances, legal holds, data-export requests, sign-in methods (without password hashes or TOTP secrets), sessions, session security events, any tokens still kept for their address, and how many recovery codes are unused. Erasure deletes the account, its username history, age-assurance results, date-of-birth changes, staff account actions, role assignments, sign-in methods, recovery codes, sessions, session security events, and the tokens and password-failure counters too unless another account uses the same address. Legal acceptances and data-export rows go with the account. Audit rows stay, so the hash chain remains intact. Objects under `users/` and `exports/` are deleted; objects under `legal-hold/` stay when `held` is true. A ledger entry `{ user_id, deleted_at }` is written to `backups.directory/deletion-ledger/` or the storage prefix `deletion-ledger/`.

## Metrics

| Metric                                     | Labels               |
| ------------------------------------------ | -------------------- |
| `qtiauth_auth_magic_links_total`           | `event`              |
| `qtiauth_auth_sign_ins_total`              | `method`, `result`   |
| `qtiauth_auth_signups_total`               | `method`, `age_band` |
| `qtiauth_auth_password_failures_total`     |                      |
| `qtiauth_auth_breach_checks_total`         | `result`             |
| `qtiauth_auth_captcha_total`               | `result`             |
| `qtiauth_auth_2fa_challenges_total`        | `factor`, `result`   |
| `qtiauth_auth_passkey_registrations_total` |                      |
| `qtiauth_auth_step_up_total`               | `result`             |
| `qtiauth_sessions_created_total`           | `method`             |
| `qtiauth_session_bindings_created_total`   |                      |
| `qtiauth_sessions_revoked_total`           | `reason`             |
| `qtiauth_sessions_active`                  |                      |
| `qtiauth_accounts`                         | `state`              |
| `qtiauth_filter_decisions_total`           | `rule`               |
| `qtiauth_usernames_claimed_total`          | `action`             |
| `qtiauth_admin_user_actions_total`         | `action`             |
| `qtiauth_account_deletions_total`          | `event`              |
| `qtiauth_data_exports_total`               | `status`             |
| `qtiauth_age_band_changes_total`           |                      |
| `qtiauth_audit_recorded_total`             |                      |
| `qtiauth_legal_acceptance_pending`         |                      |

Magic-link events are `sent`, `used`, `expired` (opened too late) and `invalid` (unknown or used already). Breach-check results are `rejected`, `passed` or `unavailable`. CAPTCHA results are `shown`, `solved` or `failed`. Two-factor `factor` is `totp`, `passkey` or `recovery`, and `result` is `success` or `failure`. Step-up results are `prompt`, `success` or `failure`. Filter `rule` is `allowlist`, `exact_block`, `dictionary`, `token_block`, `token_padded_loose`, `padded_loose` or `unknown`. Username `action` is `claim`, `change` or `reclaim`. Staff account `action` is `ban`, `unban`, `lock`, `unlock`, `force_reauth`, `revoke_sessions` or `force_username_reset`. Deletion `event` is `requested`, `cancelled` or `completed`. Data-export `status` is `ready`, `failed` or `unavailable`. Age-band changes are counted when the daily job or a staff date-of-birth edit moves someone to another band. `qtiauth_audit_recorded_total` counts rows stored from `audit.recorded`. `qtiauth_legal_acceptance_pending` is how many accounts have not accepted a currently effective material version, counted every minute. A rise in `invalid` or failed sign-ins without a rise in `sent` suggests someone guessing. `qtiauth_sessions_active` and `qtiauth_accounts` are counted every minute.

Logs never contain tokens, passwords, email addresses or dates of birth. User IDs are hashed as usual.

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
| `X-QTIAuth-Flow-Binding`     | Sets the 10-minute flow cookie that ties a social sign-in to the browser |

The gateway sends the flow cookie's value back to identity, and only to identity, in `X-QTIAuth-Flow-Binding` on each request. The names are exported from `@qtiauth/service-kit`, and `sessionHeaders`, `revokedHeaders` and `signedOutHeaders` in `services/identity/src/headers.ts` build them. Restoring a challenged session keeps the existing cookie and sends `X-QTIAuth-Revoked-Sessions` with that session's ID so the gateway drops the cached `aal0` copy.

### Tests

`captureEmails` from `services/identity/src/testing.ts` consumes the high-priority email queue as the notifier would, so tests can follow magic links, verification links and reset links without running the notifier. `gateway.integration.test.ts` runs the whole flow through a real gateway, using `gatewayService` from `@qtiauth/gateway/testing`, including a country change that drops a session to `aal0` and restores the same session, and a material legal version that gates `/api/v1/me/identities` until it is accepted. `bind.integration.test.ts` does the same across three hostnames on two registrable domains. `age.integration.test.ts` covers a birthday that crosses 18 overnight, staff date-of-birth edits, and under-18 defaults. `audit.integration.test.ts` stores an `audit.recorded` event, filters it, and checks that `qtiauth audit verify` names a row after a direct Postgres edit. `legal.integration.test.ts` syncs the shipped documents, rejects an edited body without a version bump, and covers material re-acceptance, the HTML form, and a non-material email. `admin-users.integration.test.ts` searches accounts, omits optional-service detail until those RPC methods answer, and covers ban, lock, force re-auth, session revoke and username reset. `identity.integration.test.ts` covers deletion, sign-in cancel, purge to a ledger file, an emailed export attachment, and a legal hold that outlives the account. `gateway.integration.test.ts` needs a passkey `aal2` session for `POST /api/v1/me/deletion`.
