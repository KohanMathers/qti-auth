# Threat model: games

The games service holds the catalog, entitlements, achievements, leaderboards, playtime, cloud saves and the Steam link. It's part of the `games` profile and uses the `games` schema. See [../games.md](../games.md) for the working model.

## Assets

- **Entitlements.** Per-user access to products.
- **Achievements, stats, leaderboards, playtime.**
- **Cloud saves** (bodies in object storage, metadata in Postgres).
- **Game server credentials.** One confidential OAuth client per game.
- **Steam identities** and their bindings.
- **Redeemable keys.**

## Trust boundaries

- **Gateway → games.** Requests carry a gateway-signed identity token.
- **Game servers → games.** OAuth `client_credentials` tokens for the game's own client; `auth: service` for cross-service back-end calls.
- **Game clients / servers submitting player scores.** `auth: game_authoritative` requires both a game-server token and a player access token together (§7.5); one without the other is refused.
- **Games → Steam Web API.** Egress with an operator-configured API key.
- **Games → object storage** for cloud saves.

## Threats

- **Score / achievement forgery.** Game-authoritative routes require the paired-token model; a stolen player token alone doesn't grant the ability to write scores.
- **Entitlement forgery.** Entitlements are written by the games service in response to admin grants, key redemptions, `steam.ownership_sync` and `api` grants (server-authenticated).
- **Key redemption abuse.** Per-user and per-IP limits; keys are 256-bit CSPRNG, single-use, and hashed at rest.
- **Cloud save exhaustion.** Per-user and per-slot size caps; the games service refuses uploads larger than the configured limit before signing a URL.
- **Cloud save conflict resolution abuse.** Optimistic-concurrency with a hash of the previous version; server rejects an out-of-band write.
- **Steam ticket replay.** Tickets are validated against the Steam Web API once and burnt; the resulting session-binding is bound to the account.
- **Leaderboard poisoning.** Writes go through the game-authoritative channel; retroactive edits are staff-only and audited.
- **Metadata SSRF via cloud save URL.** Save bodies pass directly between clients and object storage; the games service only signs the URL. Save metadata never contains a URL supplied by the client.
- **Leaderboard-reset race.** `leaderboards.reset_periodic` job resets under a per-leaderboard lock; interim writes are queued.

## Mitigations

- Every write route names a rate-limit policy.
- Non-root, read-only container. Only Postgres, Valkey, NATS and object storage on the internal network.
- Steam link uses a state token bound to the Steam Web API's OpenID callback.

## Open questions

- Do we want per-game leaderboard-write quotas set by the game itself, to cap runaway game servers?
- Should cloud-save encryption at rest be enforced by policy (server-side encryption on the bucket) rather than just recommended?
