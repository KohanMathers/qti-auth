# Threat model: notifier

The notifier sends email and outbound webhooks. Other services enqueue an email or a webhook subscription; the notifier renders, signs and delivers, then records the outcome. See [../notifier.md](../notifier.md) for the working model.

## Assets

- **SMTP credentials.** Loaded from env / Docker secret.
- **Webhook signing key** per endpoint.
- **Delivery logs** (audit tail with template, target, result, no bodies).
- **Endpoint URLs.** Together with the signing key they let a compromise drive downstream systems.

## Trust boundaries

- **Bus → notifier.** Publishers on the internal network. Message envelopes are trusted because NATS is network-isolated, but their payloads are still validated against schemas.
- **Notifier → SMTP server.** Egress on the configured host; TLS enforced by the provider adapter.
- **Notifier → webhook endpoints.** Operator-supplied URLs on the public internet. Every URL is validated and the target IP is checked before each request.

## Threats

- **SSRF via a webhook URL.** `parseWebhookUrl` refuses non-http(s), userinfo, and empty hostnames. `resolveWebhookHost` + `isBlockedAddress` reject loopback, link-local, private (RFC1918), unique-local IPv6 and other bogons. `allowPrivate` is only true for internal test setups. Fuzz test in `services/notifier/src/fuzz.test.ts`.
- **DNS rebind.** The DNS lookup runs immediately before the request and the connect uses the address the lookup returned, not the hostname. TOCTOU on short TTLs is still possible; a future step is to pin the resolved IP for the request's lifetime.
- **Signature forgery.** HMAC-SHA-256 with the endpoint's stored key, over the canonical body plus a timestamp; body bytes and timestamp are both in the signature.
- **Replay of a signed delivery.** Timestamp window + a delivery-id nonce that the receiver is expected to dedupe on.
- **Discord / Slack webhook abuse.** Format adapters escape user text before rendering; markdown and mentions cannot be smuggled through payload fields.
- **SMTP header injection.** Templates only fill named variables; the SMTP library rejects `\r\n` in header fields.
- **Email address disclosure.** Delivery logs redact addresses to a domain + hash beyond a configured retention window (§8.4).
- **Endpoint auto-disable abuse.** An attacker who can force enough failures can disable a real endpoint. Rate at which failures count towards auto-disable is configured; disable events go to the audit log.
- **Template injection.** Templates are pre-registered per service; a caller can only pick a name, not supply arbitrary HTML.
- **Bounce / suppression list poisoning.** Suppressions are per-address and per-provider; the CLI can lift a suppression with an audit entry.

## Mitigations

- SSRF checks documented above.
- Every outbound HTTP call has a timeout and a bounded body size.
- Non-root, read-only container. Only Postgres, Valkey and NATS on the internal network.
- Webhook signatures include the endpoint format tag to prevent cross-endpoint replay.

## Open questions

- Should we require TLS for SMTP by default (`security: starttls` today permits opportunistic upgrade)?
- Do we want to pin the resolved webhook IP for the connection lifetime?
