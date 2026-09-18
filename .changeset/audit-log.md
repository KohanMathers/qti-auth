---
'@qtiauth/identity': minor
'@qtiauth/config': minor
'@qtiauth/db': minor
'@qtiauth/cli': patch
---

Store `audit.recorded` events in an append-only hash-chained log, with an INSERT/SELECT-only Postgres role, admin filtering, and `qtiauth audit verify`.
