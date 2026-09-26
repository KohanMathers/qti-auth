---
'@qtiauth/gateway': minor
'@qtiauth/oidc': minor
'@qtiauth/games': minor
'@qtiauth/service-kit': minor
'@qtiauth/config': minor
'@qtiauth/events': minor
---

Add the trust model and game-authoritative writes: gateway `auth: game_authoritative` requires the game server's client-credentials token in `Authorization` and the player's access token in `X-QTIAuth-Player-Token`, both issued for the same game; `achievements.write` and `game_stats.write` scopes are grantable only to the game's own client; game events carry a `trust` field so external integrations can see what they are reacting to.
