---
'@qtiauth/identity': minor
'@qtiauth/oidc': minor
'@qtiauth/web': minor
---

Remove the interim server-rendered pages from the identity and OIDC services now that
the web app carries every user-facing surface. The magic-link, sign-up, register, login,
forgot- and reset-password, verify-email, revert-email, passkey, two-factor, TOTP,
username, delete, export, waiting, guardian, family dashboard, OAuth consent and device
pages are all gone, together with the bind flow (superseded by the web app), the shared
HTML helpers and every page-specific test. Email URLs now point at the web app routes:
`/verify`, `/reset`, `/guardian/approve`, `/guardian/decline`, `/family`, `/family/session`,
`/family/invite` and `/revert-email`. The web app pre-fills the token from the URL query
on the verify, reset, guardian, family and revert pages, and gains typed clients for
guardian approve/decline and the family session and invite endpoints.
