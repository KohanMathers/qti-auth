# Threat model: identity

Identity owns accounts, sign-in and sessions. It handles passwords, magic links, passkeys, TOTP, upstream providers, usernames, age bands, the audit log, legal acceptance, staff roles, deletion and export. See [../identity.md](../identity.md) for the working model.

## Assets

- **Password hashes** (Argon2id) and password reset tokens.
- **Magic-link tokens**, verification tokens, email-change confirmations.
- **TOTP secrets, recovery codes, passkey credentials.**
- **Session records and their bindings.**
- **Social provider link identifiers** (`sub` values, Steam IDs).
- **Personal data:** email, date of birth, guardian email, IPs seen, country history, staff notes, deletion ledger.
- **Audit log.** Append-only chain; a break in it is a red flag.
- **Legal document text and acceptance records.**

## Trust boundaries

- **Gateway → identity.** Requests carry a gateway-signed identity token that names the caller. Identity trusts the token's `sub` and `aal`.
- **Identity → notifier (bus).** Email requests are published as events.
- **Identity → upstream providers** (Google, GitHub, Discord, Steam, generic OIDC). All provider responses are untrusted until verified against the provider's own JWKS or an equivalent signed proof.
- **Identity → Postgres.** Only the `identity` role can read the schema.

## Threats

- **Password brute force.** Argon2id parameters follow OWASP guidance; the gateway's `auth_password` policy runs per IP and per account with a fail-closed default. Failed attempts also count for CAPTCHA thresholds.
- **Credential stuffing.** Optional breach check (HIBP k-anonymity API) is wired into signup and password change.
- **Password reset token misuse.** Tokens are 256-bit CSPRNG, hashed at rest, single-use, TTL-bound and bound to the account.
- **Magic-link forwarding attack.** The link only opens a page asking for confirmation, so a mail scanner's HEAD/GET doesn't burn the token.
- **Session fixation.** Sessions are created only after a successful factor, and rotated on step-up.
- **Session hijack from device change.** Session-security scoring can force step-up, and known-device notifications go by email.
- **Social provider spoofing.** OIDC state and PKCE stored in Valkey with a short TTL; `nonce` is verified against the ID token; Steam's OpenID 2.0 callback is checked back with the provider.
- **Steam identity replay.** `steam-identities` is a separate signing surface; tokens carry an audience and expire.
- **TOTP replay.** Codes are checked once and burnt; a small clock tolerance is allowed.
- **Recovery code exhaustion attack.** Codes are hashed, single-use, and regenerated on demand from the account page.
- **Passkey binding hijack.** Registration requires an authenticated session; authentication requires the challenge to match the stored one for that credential ID.
- **Text-filter bypass on usernames.** Confusable/leet normalisation plus token- and pad-aware matching; new bypasses go into `blockExtra` without a code change. Fuzzed in `packages/text-filter/src/fuzz.test.ts`.
- **Audit log tampering.** Every entry chains a hash of the previous. `qtiauth audit verify` walks the chain and refuses on a mismatch.
- **PII in logs.** User IDs are hashed with a shared keyed hash; emails, tokens and TOTP codes are never logged (§8.6).
- **Deletion ledger loss.** Ledger entries live for `backup retention + 30 days` (§8.4), and a restore replays them (§8.7).
- **Legal-doc rollback.** Versions are immutable once published; new versions require re-acceptance.

## Mitigations

- Identity token verification with clock tolerance and audience check.
- Every state-changing route names a rate-limit policy.
- Text filter runs on every username, display name and other public field.
- Feature flags gate every auth method; disabled methods have no reachable route.
- Non-root, read-only container; only Postgres, Valkey and NATS on the internal network.

## Open questions

- Should recovery codes have a hard cap on how often they can be re-generated per rolling 24h?
- Do we need per-provider quotas on social sign-in failures, in addition to the shared IP policy?
