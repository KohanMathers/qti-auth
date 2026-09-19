---
'@qtiauth/keys': minor
'@qtiauth/gateway': minor
---

Add `@qtiauth/keys` for signing-key generation, envelope encryption with `KEY_ENCRYPTION_KEY`, and rotation that keeps the previous key published until tokens it signed have expired. The gateway now uses it for internal identity tokens.
