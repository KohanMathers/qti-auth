# Threat model: gateway

The gateway is the only public entry point. It matches every request against
the route table services announce, resolves the caller's session, applies rate
limits and the route's policy, and forwards the request with a short-lived
internal identity token. See [../gateway.md](../gateway.md) for the working
model.

## Assets

- **Session cookies and their bindings.** Opaque values that grant a caller
  the signed-in user's authority.
- **OAuth access tokens.** Third-party clients present bearer JWTs for API
  calls.
- **The identity-token signing keys.** Used to mint the internal token each
  upstream service trusts.
- **Rate-limit counters in Valkey.** Attackers who erase them get free retries;
  attackers who forge them can lock a user out.
- **The route table and OpenAPI document.** They expose the shape of every
  route but no secrets.

## Trust boundaries

- **Public → gateway.** All input is untrusted: method, host, path, query,
  body, cookies, headers.
- **Gateway → services (internal network).** Requests carry an identity token
  signed by the gateway. Services trust the token, not the caller's cookies.
- **Gateway → Valkey.** Rate-limit counters and session cache. Auth policies
  fail closed when Valkey is unreachable.
- **Gateway → identity (session RPC).** The gateway asks identity to resolve a
  binding token; identity trusts the gateway is a peer on the internal network.

## Threats

- **Spoofed source IP via `X-Forwarded-For`.** Trusted-proxy CIDRs pin which
  hops may set the header, so an untrusted client cannot smuggle an IP.
  (`services/gateway/src/client-ip.ts`).
- **Session fixation or cookie theft.** Session cookies are `HttpOnly`,
  `Secure`, `SameSite=Lax`, `__Host-` prefixed by default. State-changing
  requests must carry a matching `Origin` (§2.7).
- **CSRF.** `SameSite=Lax` plus the `Origin` check on every state-changing
  request. A missing `Origin` on a cookie'd state-changing request is refused.
- **Rate-limit bypass.** Every route names a policy, plus the global one. The
  gateway's route lookup refuses to serve a route without a policy and reports
  the mismatch on `/api/v1/meta/health`.
- **Rate-limit erosion by counter reset (Valkey outage).** Policies default to
  fail-open, but auth-critical policies (`auth_password`, `auth_verify`,
  `magic_link_*`) fail closed.
- **Header injection or response smuggling.** All headers go through
  `applySecurityHeaders`, which strips `Server`/`X-Powered-By` and enforces the
  baseline CSP, HSTS and clickjacking headers.
- **Open redirect on binding.** `bindStartUrl` is composed from a signed
  route table entry, and `return_to` is validated against the surface's own
  origins.
- **OpenAPI leak.** The document exposes route shapes but no secrets. Routes
  that require auth still say so in the document, so this is intended
  behaviour.
- **DoS by large body.** The gateway enforces `gateway.http.max_body_size`
  before forwarding, and only reads the body when a rate-limit dimension needs
  a form field.
- **Identity token misuse.** Tokens are audience-bound to the upstream service
  and short-lived (`identity_tokens.clock_tolerance`). Services reject a token
  whose `aud` doesn't match their own name.

## Mitigations

- Baseline security headers on every response (§8.9,
  `services/gateway/src/headers.ts`).
- CORS preflight only for surface-registered origins
  (`services/gateway/src/cors.ts`).
- Every route names a rate-limit policy; the global policy also runs
  (`services/gateway/src/rate-limit.ts`).
- Only the `internal` and `public` Docker networks are used, and only the
  gateway is on `public`. Compose test enforces this.
- Non-root, read-only container with no capabilities. Compose test enforces
  this too.
- Route table is verified against announced manifests; unknown or duplicate
  routes are surfaced as health problems, not silently discarded.

## Open questions

- How is the gateway's identity-key rotation observed? (`keys.rotate` job and
  `qtiauth_gateway_identity_key_age_seconds` metric.)
- Do we need a hard cap on `Set-Cookie` size, in addition to the per-cookie
  scheme?
