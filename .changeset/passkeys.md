---
'@qtiauth/identity': minor
'@qtiauth/config': minor
'@qtiauth/service-kit': patch
'@qtiauth/gateway': minor
---

Add passkeys, TOTP, recovery codes and step-up. Passkey-only sign-in reaches aal2. Routes with step_up: true need a recent aal2 session. Staff matching security.require_2fa_for_permissions must enrol before using the rest of the product.
