---
'@qtiauth/oidc': minor
'@qtiauth/gateway': minor
'@qtiauth/identity': minor
'@qtiauth/service-kit': minor
'@qtiauth/events': minor
'@qtiauth/config': minor
---

Add the OIDC provider: discovery, JWKS, authorization-code with mandatory PKCE S256, exact and RFC 8252 loopback redirects, an interim consent screen with stored consent and first-party skip, RFC 9068 access tokens and ID tokens (ES256 and RS256, `at_hash`), refresh rotation with reuse detection that revokes the family, userinfo, revoke and introspect, and scopes and claims from config including `age`, `parental_controls` and `restrictions`. The gateway now enforces `auth: oauth` (audience and scopes), redirects browser navigations that need a session to login, and rejects OAuth access tokens on session routes. Identity answers `qtiauth.rpc.identity.user_claims`. The Compose stack now builds and runs oidc.
