---
'@qtiauth/notifier': minor
'@qtiauth/email': minor
'@qtiauth/bus': minor
'@qtiauth/config': minor
'@qtiauth/testing': patch
---

Add the notifier service, which sends email from MJML and text templates through the `smtp` or `console` provider. Templates can be overridden per locale from config, and the notifier refuses to start if a template uses a variable it isn't given or has invalid MJML, with `qtiauth templates check` running the same checks. Email is queued on high and normal priority JetStream work queues, retried for hours when the provider is down, and recorded in a delivery log that `retention.sweep` prunes and data rights cover. Add `@qtiauth/email` with the template definitions and `queueEmail`, a per-consumer `retry` option to `@qtiauth/bus` consumers, and the `email.default_locale`, `email.templates_dir`, `email.smtp` and `email.queue` settings and the `retention` section to `@qtiauth/config`, where `email.provider` now only accepts `smtp` and `console`. The Compose stack now builds and runs the notifier, and needs `qtiauth db provision` before the first start.
