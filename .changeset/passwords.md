---
'@qtiauth/identity': minor
'@qtiauth/config': minor
'@qtiauth/email': minor
'@qtiauth/notifier': minor
---

Add password sign-in and signup to identity: Argon2id with rehash on login, optional composition rules, HIBP k-anonymity (fails open), email local-part containment, progressive delay without lockout, and equal-time login for unknown addresses. Password signup emails a confirmation link and stays `pending_email_verification` until it is used. Accounts without a password can add one after a recent magic-link sign-in; changing one needs the current password. Forgot-password reset links revoke other sessions unless `keep_other_sessions` is true. Add the `password` config section and the `email_verification` and `password_reset` templates.
