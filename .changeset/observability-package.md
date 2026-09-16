---
'@qtiauth/observability': minor
'@qtiauth/bus': minor
'@qtiauth/db': minor
'@qtiauth/events': minor
'@qtiauth/config': minor
---

Add `@qtiauth/observability` (structured JSON logs with redaction and hashed user IDs, a log-scrubbing test helper, OpenTelemetry tracing for HTTP, Kysely and NATS, a Prometheus registry that rejects unbounded label names, and `/healthz` and `/readyz` helpers) and the `observability` config section. `createDb` now traces queries, the bus traces publishing, consuming and request/reply, event envelopes gain `span_id`, and `prometheusBusMetrics`, `busHealthCheck` and `databaseHealthCheck` are new.
