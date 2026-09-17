---
'@qtiauth/identity': minor
'@qtiauth/gateway': minor
'@qtiauth/service-kit': minor
'@qtiauth/events': minor
'@qtiauth/config': minor
'@qtiauth/testing': patch
---

Add the identity service, with accounts and a single account state machine, per-domain email normalization and `accounts.max_per_email`, magic-link sign-in and signup that answers the same whether or not an account exists, a scanner-safe confirmation page with the date of birth asked after the click, and opaque sessions with hashed tokens, per-host bindings, idle and absolute expiry and eviction over `sessions.max_per_user`. Users can see their account at `/api/v1/me`, list and revoke their sessions and sign out. Identity answers `qtiauth.rpc.identity.resolve_session`, publishes `identity.user.created`, `identity.session.created` and `identity.session.revoked`, sweeps old sessions and tokens on `retention.sweep` and covers them in data exports and erasure. The gateway now sets and clears the session cookie when identity asks through `X-QTIAuth-Session-*` response headers, and drops revoked sessions from its cache before answering, with the header names exported from `@qtiauth/service-kit`. Add the identity event schemas to `@qtiauth/events`, and the `accounts`, `magic_link`, `sessions`, `age` and `parental` sections, `retention.sessions`, `retention.tokens` and the `auth_verify` rate-limit policy to `@qtiauth/config`. Under `parental.consent_age`, signup is refused until parental consent is available. The Compose stack now builds and runs identity.
