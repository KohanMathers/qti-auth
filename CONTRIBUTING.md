# Contributing to QTIAuth

Thanks for helping. This guide covers how to get set up and what a pull request needs.

Before starting on anything substantial, open an issue first to see if your feature is within scope.

Security problems go through [SECURITY.md](SECURITY.md), not public issues.

## Requirements

- **Node.js 26** (see `.nvmrc`)
- **pnpm 12.4.2**. If a different pnpm is installed, it downloads the right version automatically.
- **Docker** with Compose, for integration tests (Testcontainers starts Postgres, Valkey and NATS) and for running the stack (see [docs/deployment.md](docs/deployment.md))

## Setup

```sh
pnpm install
```

This also installs the Git hooks.

## Layout

| Path                 | Contents                             |
| -------------------- | ------------------------------------ |
| `packages/`          | Shared libraries (`@qtiauth/*`)      |
| `services/`          | Deployable services, one image each  |
| `templates/service/` | Starting point for new services      |
| `config/`            | Brand-neutral default configuration  |
| `deploy/`            | Docker Compose files                 |
| `docs/`              | Operator and developer documentation |
| `scripts/`           | Repository tooling                   |

## Everyday commands

| Command                             | What it does                                                                     |
| ----------------------------------- | -------------------------------------------------------------------------------- |
| `pnpm test`                         | Unit tests                                                                       |
| `pnpm test:integration`             | Integration tests (needs Docker)                                                 |
| `pnpm lint` / `pnpm lint:fix`       | ESLint                                                                           |
| `pnpm format` / `pnpm format:check` | Prettier                                                                         |
| `pnpm typecheck`                    | TypeScript across the workspace                                                  |
| `pnpm check:hardcoded`              | Fails on deployment-specific values in source                                    |
| `pnpm changeset`                    | Record a change for the changelog                                                |
| `pnpm qtiauth <command>`            | Run the `qtiauth` CLI from source                                                |
| `pnpm config:schema`                | Regenerate `config/qtiauth.schema.json`                                          |
| `pnpm stack:dev <compose args>`     | Docker Compose with the development override, e.g. `pnpm stack:dev up -d --wait` |

## How code is written here

- TypeScript runs directly on Node using type stripping, with no build step. Only erasable syntax is allowed, so no `enum`, `namespace` or constructor parameter properties. The compiler enforces this.
- Node won't strip types from files under `node_modules`, so images keep the workspace layout (see `templates/service/Dockerfile`). Don't use `pnpm deploy`, which copies workspace packages into `node_modules`.
- Relative imports include the `.ts` extension: `import { health } from './health.ts'`.
- Tests sit next to the code: `thing.test.ts` for unit tests, `thing.integration.test.ts` for tests that need containers.
- Nothing deployment-specific in source. Domains, brand and company names, reserved prefixes and the like belong in config. `pnpm check:hardcoded` enforces this, using the rules in `scripts/hardcoded-rules.json`.

## Commits

Commits follow [Conventional Commits](https://www.conventionalcommits.org/). A Git hook checks each message, and CI checks every commit in a pull request.

```
feat(identity): add passkey registration
fix(gateway): apply rate limits to magic-link routes
docs: explain session bindings
```

## Pull requests

1. Branch from `main`.
2. Make the change, with tests.
3. Run `pnpm changeset` if a package or service changed.
4. Make sure `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test` and `pnpm check:hardcoded` pass. This can all be tested in one through `pnpm commitcheck`.
5. Open the pull request.

## Code of conduct

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).
