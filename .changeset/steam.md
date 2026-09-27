---
'@qtiauth/games': minor
'@qtiauth/identity': minor
'@qtiauth/service-kit': minor
'@qtiauth/config': minor
---

Add Steam integration: `POST /api/v1/games/steam/authenticate` verifies Steamworks web-API tickets with per-app family-sharing policy and ban flags, links look up the QTIAuth user by SteamID64, ownership sync grants and revokes the base product from Steam nightly without touching entitlements from other sources, and unlinking a Steam identity holds the same SteamID64 out of every account until the cooldown ends.
