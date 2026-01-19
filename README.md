# QTI Auth System

Serverless authentication system for QTI Games built on Cloudflare Workers + D1.

## Features

- Passwordless authentication (OAuth + email magic links)
- Age verification and child account protections
- User reporting and moderation queue
- Session management with fingerprint tracking
- Game statistics and achievements
- Minecraft account linking (JagSMP)

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Cloudflare Edge                       │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  ┌──────────────┐    ┌──────────────┐    ┌───────────┐  │
│  │   Frontend   │    │    Worker    │    │    D1     │  │
│  │ (React/Vite) │───▶│    (Hono)    │───▶│  (SQLite) │  │
│  │   on Pages   │    │     API      │    │           │  │
│  └──────────────┘    └──────────────┘    └───────────┘  │
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │        OAuth Providers (Google/GitHub/Discord)    │   │
│  └──────────────────────────────────────────────────┘   │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

## Quick Start

### Prerequisites

- Node.js 18+
- Cloudflare account
- Wrangler CLI: `npm install -g wrangler`

### Setup

```bash
# Install dependencies
npm install

# Create D1 database
wrangler d1 create qti_auth
# Copy the database ID into wrangler.toml

# Run migrations
wrangler d1 execute qti_auth --file=./schema.sql

# Set JWT secret
wrangler secret put JWT_SECRET

# Deploy worker
wrangler deploy

# Deploy frontend
cd frontend
npm install
npm run build
wrangler pages deploy dist --project-name=qti-auth-frontend
# Note: You MUST use --project-name=qti-auth-frontend or Cloudflare refuses to deploy the project
```

## Project Structure

```
qti-auth/
├── schema.sql              # D1 database schema
├── worker.js               # Cloudflare Worker API
├── wrangler.toml           # Worker configuration
├── package.json            # Dependencies
├── frontend/
│   ├── src/
│   │   ├── App.jsx         # React app with routing
│   │   ├── pages/          # Page components
│   │   └── components/     # Reusable components
│   └── package.json
└── migrations/             # Database migrations
```

## API Endpoints

### Authentication

```
POST   /auth/oauth/start        Start OAuth flow
GET    /auth/oauth/callback     OAuth callback
POST   /auth/email/start        Send magic link
POST   /auth/email/verify       Verify magic link
POST   /auth/age/verify         Submit date of birth
GET    /me                      Get current user
POST   /logout                  End session
```

### Username Management

```
POST   /username/claim          Claim initial username
POST   /username/change         Change username (with cooldown)
```

### Reporting & Moderation

```
POST   /report/user             Report a user
POST   /report/content          Report content
GET    /report/status/:id       Check report status
GET    /moderation/queue        View pending reports (admin)
POST   /moderation/action       Take action on report (admin)
POST   /moderation/dismiss      Dismiss report (admin)
```

### Sessions

```
GET    /sessions                Get user's active sessions
POST   /sessions/:id/revoke     Revoke a specific session
POST   /sessions/revoke-all     Revoke all other sessions
```

### Admin

```
GET    /admin/stats             Dashboard statistics
POST   /admin/cleanup           Database cleanup
```

### Game Stats

```
GET    /games                   List games
GET    /games/:slug/stats       Get user stats for a game
```

### JagSMP (Minecraft)

```
POST   /jagsmp/generate-code    Generate link code (plugin)
POST   /jagsmp/link             Link Minecraft account
POST   /jagsmp/unlink           Unlink Minecraft account
GET    /jagsmp/me               Get linked account and stats
```

## Configuration

Environment variables (set via `wrangler secret put`):

| Variable | Description |
|----------|-------------|
| `JWT_SECRET` | Secret for JWT signing |
| `EMAIL_SERVICE_API_KEY` | Brevo API key for emails |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `GITHUB_CLIENT_ID` | GitHub OAuth client ID |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth client secret |
| `DISCORD_CLIENT_ID` | Discord OAuth client ID |
| `DISCORD_CLIENT_SECRET` | Discord OAuth client secret |
| `MINECRAFT_PLUGIN_SECRET` | Secret for Minecraft plugin auth |

## Development

```bash
# Run worker locally
wrangler dev

# Run frontend locally
cd frontend
npm run dev
```

## License

Copyright Quiet Terminal Interactive. All rights reserved.
