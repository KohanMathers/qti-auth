# QTI Auth

QTI Auth is a Cloudflare Workers + D1 account and authentication platform with:
- Passwordless login (email magic links + OAuth social login)
- Session and account security controls
- Moderation/reporting workflows
- OAuth 2.1 / OIDC provider endpoints ("Sign in with QTI")
- Optional game stats and support ticket modules

## Open-Source Safe Baseline

This repository is sanitized for open source:
- No production D1 IDs in tracked config
- No tracked local `.env` files
- No tracked runtime/build artifacts
- Canonical database bootstrap file: `setup.sql`

If you already run this in production, keep your real values only in:
- Cloudflare secrets (`wrangler secret put ...`)
- Untracked local env/config files
- Your deployment platform settings

## Requirements

- Node.js 18+
- npm
- Cloudflare account + Wrangler CLI (`npm i -g wrangler`)

## Quick Start

1. Install dependencies

```bash
npm install
cd frontend && npm install && cd ..
cd support-frontend && npm install && cd ..
```

2. Configure Worker

- Edit `wrangler.toml`:
  - `database_id`
  - routes/domains (defaults are current production values)
  - environment URLs

3. Create and initialize D1

```bash
wrangler d1 create qti_auth
wrangler d1 execute qti_auth --file=./setup.sql
```

4. Set required secrets

```bash
wrangler secret put JWT_SECRET
wrangler secret put EMAIL_SERVICE_API_KEY
```

5. Set optional secrets (if using these features)

```bash
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
wrangler secret put GITHUB_CLIENT_ID
wrangler secret put GITHUB_CLIENT_SECRET
wrangler secret put DISCORD_CLIENT_ID
wrangler secret put DISCORD_CLIENT_SECRET
wrangler secret put MINECRAFT_PLUGIN_SECRET
wrangler secret put OAUTH_PROVIDER_PRIVATE_KEY
wrangler secret put OAUTH_PROVIDER_PUBLIC_KEY
```

6. Create local frontend env files

```bash
cp frontend/.env.example frontend/.env.local
cp support-frontend/.env.example support-frontend/.env.local
```

7. Run locally

```bash
npm run dev
# frontend in another terminal
cd frontend && npm run dev
# support frontend in another terminal
cd support-frontend && npm run dev
```

## Branding Config

Branding is centralized and overrideable via config/env while keeping current production values as defaults.

- Worker branding/domain defaults: `worker.js` via `BRANDING_DEFAULTS`, override in `wrangler.toml` `[vars]`:
  - `BRAND_NAME`
  - `COMPANY_NAME`
  - `API_URL`
  - `FRONTEND_URL`
  - `COOKIE_DOMAIN`
  - `OAUTH_REDIRECT_URI`
  - `CORS_ORIGINS`
  - `SECURITY_SENDER_NAME`
  - `SECURITY_SENDER_EMAIL`
  - `AUTH_SENDER_NAME`
  - `AUTH_SENDER_EMAIL`
  - `SERVICE_DOCUMENTATION_URL`
- Account frontend branding defaults: `frontend/src/config/branding.js`, override via `frontend/.env.local`.
- Support frontend branding defaults: `support-frontend/src/config/branding.js`, override via `support-frontend/.env.local`.

## Database

- `setup.sql`: full schema for a fresh environment
- `migrations/`: historical incremental migrations
- `schema.sql`: legacy full-schema file retained for compatibility

For new installs, use `setup.sql`.

## Scripts

From repository root:

```bash
npm run dev
npm run deploy
npm run db:create
npm run db:migrate
npm run db:migrate:local
npm run tail
```

## Repo Layout

- `worker.js` - Worker API
- `setup.sql` - canonical DB setup
- `migrations/` - migration history
- `frontend/` - account frontend
- `support-frontend/` - support portal frontend
- `wrangler.toml` - Worker deployment config template

## Security Notes

- Never commit `.env.local`, `.env.staging`, or private keys.
- Keep all credentials in Cloudflare secrets or external secret managers.
- Rotate production secrets before first public release if this repo was previously private.

## License

MIT. See `LICENSE`.
