---
'@qtiauth/service-kit': minor
'@qtiauth/cli': minor
'@qtiauth/config': minor
---

Add `@qtiauth/service-kit`: a Hono service skeleton that loads config, migrates, connects to NATS, runs the outbox relay and shuts down gracefully; internal identity token signing and verification with gateway keys fetched over the bus; route definitions that produce request validation, policy checks, the route manifest and OpenAPI 3.1 from one source; RFC 9457 Problem Details with an error-code registry; cursor pagination; permission declarations; `export_user` and erasure handler registration; service announcements; and `runServiceCli` with `routes manifest` and `routes openapi`. `@qtiauth/cli` gains `configCommand`, and `@qtiauth/config` gains the `service` section.
