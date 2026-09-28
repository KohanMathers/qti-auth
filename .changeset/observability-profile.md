---
'@qtiauth/testing': patch
---

Add the `observability` Compose profile: Prometheus (scraping every service's `/metrics`), Grafana (provisioned with Prometheus, Tempo and Loki datasources plus dashboards for the stack overview, gateway, auth and sessions, bus, notifier, OIDC, Safety, Support, Games and infra), Tempo and Loki. Ship the SPEC §8.6 alert rules and a metrics-coverage audit test that keeps every emitted `qtiauth_` metric wired to a dashboard.
