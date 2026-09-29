# Threat model: oidc

OIDC is the OAuth 2.1 / OpenID Connect provider and developer portal. It runs with the `oidc` profile and uses the `oidc` schema. See [../oidc.md](../oidc.md) for the working model.

## Assets

- **Signing keys** for ID tokens, access tokens and back-channel logout requests. Encrypted at rest with `KEY_ENCRYPTION_KEY`.
- **Registered clients**, their secrets (hashed), redirect URIs and allowed scopes.
- **Authorization codes, refresh tokens, device codes and pushed authorization requests.**
- **Consent records** linking a user to a client.
- **Guardian-approval requests** for child accounts.

## Trust boundaries

- **Gateway → oidc.** As with identity, requests carry a gateway-signed identity token when the caller has a session.
- **Registered clients → oidc.** Client credentials arrive over Basic auth or a `client_secret_post` body; the client identifies itself and OIDC verifies.
- **Relying parties → oidc discovery / JWKS.** Public endpoints; contents are meant to be scraped by clients.

## Threats

- **Open redirect via `redirect_uri`.** `redirectsMatch` requires exact scheme, hostname, path and query. Loopback ports are the only relaxation. Fuzzed in `services/oidc/src/fuzz.test.ts`.
- **PKCE downgrade.** `code_challenge_method` must be `S256`, `code_challenge` must match the length regex, and the verifier is length-checked before hashing. `pkceMatches` is constant-time in effect because SHA-256 output size is fixed.
- **Authorization code replay.** Codes are single-use, hashed at rest, short-TTL, bound to the client, redirect URI and PKCE challenge.
- **Refresh-token replay / theft.** Rotation on every use; a reuse detection invalidates the whole refresh chain and emits a metric.
- **Confused-deputy via public clients.** Public clients cannot use `client_credentials`; token exchange requires PKCE.
- **PAR request forgery.** `request_uri` handles are single-use and bound to the client. Extra `redirect_uri` / `response_type` / `scope` / `code_challenge` on the authorize call with a `request_uri` are refused (`extraAuthorizeParams`).
- **Device-code phishing.** User codes are drawn from a short character set; polling is rate-limited; verification URL uses an https origin.
- **ID token audience confusion.** `aud` includes the client, `iss` names the authorization server; the JWT `typ` (`at+jwt` or `id_token`) is checked on verification.
- **Back-channel logout DoS.** Deliveries are queued with retries and exponential backoff; endpoints auto-disable after configured failures.
- **Guardian approval hijack.** Approval tokens are 256-bit CSPRNG, TTL-bound and single-use; the guardian's email address is not disclosed to the requesting client.
- **Client secret leak in logs.** Secrets are hashed at rest; presented secrets are compared in constant time and never logged.
- **`code_challenge_method: plain` sneaking in.** Explicitly refused.
- **Malformed OAuth params.** Zod schemas cap every field length in the authorize query. Fuzz test covers the parser boundary.

## Mitigations

- Nonce-based CSP on interim consent / device pages.
- Every state-changing route names a rate-limit policy.
- All tokens are 256-bit CSPRNG, hashed at rest.
- Non-root, read-only container.

## Open questions

- Should `request_uri` handles carry per-client entropy so cross-client targeting attacks are impossible even if the store is compromised?
- Do we want to expose a JWKS rotation grace-period parameter to relying parties?
