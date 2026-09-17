---
'@qtiauth/gateway': minor
'@qtiauth/valkey': minor
'@qtiauth/bus': minor
'@qtiauth/config': minor
'@qtiauth/testing': patch
---

Add the gateway service: surface routing, a route table built from service announcements, declared route policy with the legal and parental gates, session resolution through Valkey with identity as the fallback, internal identity tokens signed with encrypted Ed25519 keys kept in NATS and rotated by `keys.rotate`, sliding-window rate limits in Valkey, trusted-proxy client IPs, CORS and the `Origin` check, security headers, a merged OpenAPI document and `/api/v1/meta/features` and `/api/v1/meta/health`. Add `@qtiauth/valkey` for Valkey connections and health checks, `consumeIdempotentEvents` to `@qtiauth/bus`, and the `valkey`, `gateway`, `rate_limits` and `security` config sections, `surfaces.<name>.origins` and `cookies.name` to `@qtiauth/config`. The Compose stack now builds and runs the gateway on port 8000.
