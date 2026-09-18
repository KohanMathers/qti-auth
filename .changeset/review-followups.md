---
'@qtiauth/identity': patch
'@qtiauth/config': patch
'@qtiauth/db': patch
'@qtiauth/events': patch
'@qtiauth/storage': patch
'@qtiauth/service-kit': patch
'@qtiauth/scheduler': patch
---

Staff ban, lock and unlock now answer a conflict instead of recording an action when the account changed state in the meantime. Data exports left pending by a restart are picked up by the new `accounts.resume_exports` job. Legal update emails go out in resumable batches from `legal.publish` instead of at startup. The storage readiness check no longer lists the bucket. Filter list changes and their audit events are written together. Password signups record the client IP on legal acceptance, and concurrent first sign-ins can no longer both become admin.
