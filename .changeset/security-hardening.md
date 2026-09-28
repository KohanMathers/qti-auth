---
'@qtiauth/gateway': patch
'@qtiauth/identity': patch
'@qtiauth/oidc': patch
'@qtiauth/notifier': patch
'@qtiauth/text-filter': patch
'@qtiauth/testing': patch
---

Security hardening (SPEC §8.9, §2.7): identity and OIDC HTML pages carry a nonce-based CSP and thread the nonce into the captcha widget, headers audit tests are added to the gateway, the Compose test enforces non-root, read-only, no-caps for every service and the `USER node` line in every Dockerfile, and per-service threat models land under `docs/threat-models/`. Fuzz tests cover the text filter, OIDC redirect/PKCE/PAR parameters and webhook URL validation, and a load test caps the gateway rate-limiter under concurrent workers.
