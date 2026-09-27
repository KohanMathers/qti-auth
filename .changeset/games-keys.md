---
'@qtiauth/games': minor
'@qtiauth/config': minor
---

Add key redemption to the games service: batch generation with label and optional expiry, session-authenticated `/api/v1/games/keys/redeem` with the `key_redeem` rate limit and CAPTCHA after `captcha.after` failed attempts from an IP, admin listing and detail, step-up-guarded plaintext CSV export sealed with `security.encryption_key`, and batch revoke that optionally revokes entitlements granted from the batch.
