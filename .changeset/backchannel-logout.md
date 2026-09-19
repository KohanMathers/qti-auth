---
'@qtiauth/oidc': minor
'@qtiauth/config': minor
---

Add OpenID Connect back-channel logout: clients register a logout URI, a signed logout token is POSTed when a session ends from any cause, delivery is queued with retries, and refresh tokens with `offline_access` survive logout unless the account is locked, banned or deleted.
