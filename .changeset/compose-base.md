---
'@qtiauth/testing': patch
---

Add a unit test that keeps `deploy/compose.yaml` in step with the Testcontainers images, checks that every Compose profile has its services and that nothing publishes a port, and checks that `.env.example` documents every variable the Compose files use.
