---
'@qtiauth/config': patch
---

Add the `edge` profile: a Caddy container that terminates TLS in front of the gateway and gets Let's Encrypt certificates automatically. Set `EDGE_HOSTS` and `EDGE_ACME_EMAIL` in `.env` and start with `--profile edge`. The shipped `network.trusted_proxies` covers Docker's private IP ranges so the gateway trusts Caddy's forwarded headers.
