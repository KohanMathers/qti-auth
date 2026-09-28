# Threat model: support

The support service holds tickets, appeals, guest tickets, attachments and
canned responses. See [../support.md](../support.md) for the working model.

## Assets

- **Ticket bodies, attachments and internal notes.**
- **Guest ticket contact details.**
- **Appeal linkage** to safety enforcement actions.
- **Staff notes** (internal-only).

## Trust boundaries

- **Gateway → support.** Requests carry a gateway-signed identity token.
- **Guest → support.** No session. Guest tickets are rate-limited per IP,
  identified by a signed cookie for one-off follow-ups.
- **Support ↔ safety (bus).** Cross-service linkage for appeals.
- **Support → object storage** for attachments (presigned URLs).

## Threats

- **Guest ticket abuse.** Per-IP rate limits, CAPTCHA at threshold, per-IP
  daily cap. Guest ticket bodies pass through the text filter.
- **PII leak via attachments.** Attachments upload directly to object
  storage with a presigned URL; file bodies never pass through the gateway.
  Content-type is validated by the frontend and re-checked on read; the URL
  is signed for a short window.
- **Ticket-hijack by ID guessing.** Ticket IDs are UUIDv7; access checks are
  per-user and per-ticket.
- **XSS in ticket rendering.** All rendering escapes HTML; markdown is
  rendered through a strict allowlist. Interim pages use the same CSP as
  identity.
- **Staff-note leakage.** Notes are only served on the staff support route
  (`support:tickets:respond`); user routes strip them.
- **Enumeration via error messages.** Errors are RFC 9457 Problem Details
  with stable codes; a not-found and a not-authorised return the same code
  to non-staff.

## Mitigations

- Bus, Postgres and object storage on the internal network (MinIO or an
  external S3 endpoint the gateway does not proxy to).
- Non-root, read-only container.
- Attachments carry a per-file random path and a short-lived presigned URL.

## Open questions

- Should we scan uploaded attachments for known malware signatures before
  serving them (out of scope for v1)?
