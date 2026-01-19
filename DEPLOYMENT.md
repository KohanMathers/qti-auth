# QTI Auth System - Deployment Guide

## Overview

Production-ready authentication system for QTI Games built on Cloudflare's serverless infrastructure.

## Architecture

- **Backend**: Cloudflare Workers (Hono framework)
- **Database**: Cloudflare D1 (distributed SQLite)
- **Frontend**: React + Vite (deployed to Cloudflare Pages)
- **100% serverless**, globally distributed

---

## Prerequisites

1. **Cloudflare Account** (free tier works for development)
2. **Node.js 18+** and npm
3. **Wrangler CLI**: `npm install -g wrangler`
4. **Domain** (optional for production)

---

## Step 1: Database Setup

### Create D1 Database

```bash
cd /path/to/qti-auth
wrangler d1 create qti_auth
```

Copy the database ID and update `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "qti_auth"
database_id = "YOUR_DATABASE_ID_HERE"
```

### Run Migrations

```bash
# For production
wrangler d1 execute qti_auth --file=./schema.sql

# For local development
wrangler d1 execute qti_auth --local --file=./schema.sql
```

---

## Step 2: Worker Configuration

### Set Secrets

```bash
# JWT secret for session signing
wrangler secret put JWT_SECRET
# Enter a strong random string (e.g., output of: openssl rand -base64 32)

# OAuth provider credentials
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
wrangler secret put GITHUB_CLIENT_ID
wrangler secret put GITHUB_CLIENT_SECRET
wrangler secret put DISCORD_CLIENT_ID
wrangler secret put DISCORD_CLIENT_SECRET

# Email service API key (Brevo)
wrangler secret put EMAIL_SERVICE_API_KEY

# Minecraft plugin secret (for JagSMP)
wrangler secret put MINECRAFT_PLUGIN_SECRET
```

### Update wrangler.toml

```toml
[vars]
ENVIRONMENT = "production"
FRONTEND_URL = "https://account.yourdomain.com"
OAUTH_REDIRECT_URI = "https://auth.yourdomain.com/auth/oauth/callback"
COOKIE_DOMAIN = ".yourdomain.com"
```

---

## Step 3: Deploy Worker

```bash
npm install
wrangler deploy
```

Your API will be available at `https://qti-auth.YOUR_SUBDOMAIN.workers.dev`

---

## Step 4: Frontend Setup

```bash
cd frontend
npm install
```

### Configure Environment

Create `frontend/.env.local`:

```env
VITE_API_URL=https://auth.yourdomain.com
```

### Build & Deploy

```bash
npm run build
wrangler pages deploy dist --project-name=qti-auth-frontend
```

**Note: You MUST use `--project-name=qti-auth-frontend` or Cloudflare refuses to deploy the project** (the root `wrangler.toml` is configured for Workers and conflicts with Pages deployment).

---

## Step 5: Custom Domains

### Worker Custom Domain

1. Go to Workers & Pages → qti-auth
2. Click "Triggers" → "Add Custom Domain"
3. Enter: `auth.yourdomain.com`

### Pages Custom Domain

1. Go to Pages → qti-auth-frontend
2. Click "Custom domains" → "Set up a custom domain"
3. Enter: `account.yourdomain.com`

---

## Step 6: OAuth Setup

### Google OAuth

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create OAuth 2.0 credentials
3. Add redirect URI: `https://auth.yourdomain.com/auth/oauth/callback`
4. Set secrets: `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`

### GitHub OAuth

1. Go to GitHub Settings → Developer settings → OAuth Apps
2. Create new OAuth App
3. Callback URL: `https://auth.yourdomain.com/auth/oauth/callback`
4. Set secrets: `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`

### Discord OAuth

1. Go to [Discord Developer Portal](https://discord.com/developers)
2. Create new application
3. Add redirect: `https://auth.yourdomain.com/auth/oauth/callback`
4. Set secrets: `DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET`

---

## Step 7: Create First Admin Account

Admin accounts cannot be created through OAuth or signup. Create manually:

```bash
wrangler d1 execute qti_auth --command="
INSERT INTO users (
  id, username_original, username_canonical, email, role,
  date_of_birth, is_child, age_verified_at, age_verification_method,
  created_at, updated_at
) VALUES (
  '$(uuidgen)',
  'QTI_Admin',
  'qti_admin',
  'admin@yourdomain.com',
  'admin',
  '1990-01-01',
  0,
  $(date +%s),
  'manual',
  $(date +%s),
  $(date +%s)
);
"
```

---

## Step 8: Testing

### Local Development

```bash
# Terminal 1 - Run Worker
wrangler dev

# Terminal 2 - Run Frontend
cd frontend
npm run dev
```

### Test Endpoints

```bash
# Health check
curl https://auth.yourdomain.com/health

# Create account (magic link)
curl -X POST https://auth.yourdomain.com/auth/email/start \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","date_of_birth":"2000-01-01"}'
```

---

## Production Checklist

- [ ] D1 database created and migrated
- [ ] All secrets set (JWT, OAuth, email)
- [ ] Custom domains configured
- [ ] First admin account created
- [ ] OAuth apps configured
- [ ] Email service integrated
- [ ] ToS and Privacy Policy linked
- [ ] Banned words list expanded
- [ ] Backup strategy configured

---

## Backup & Recovery

### Backup D1 Database

```bash
wrangler d1 export qti_auth --output=backup.sql
```

### Restore from Backup

```bash
wrangler d1 execute qti_auth --file=backup.sql
```

---

## Monitoring

Access admin dashboard at: `https://account.yourdomain.com/mod/queue`

Key metrics to track:
- Pending reports
- Reports actioned within 24h
- Child users as % of total
- Banned accounts

### Export Data

```bash
# Get daily stats
wrangler d1 execute qti_auth --command="
SELECT * FROM daily_stats
WHERE date >= date('now', '-30 days')
ORDER BY date DESC;
"

# Get recent moderation actions
wrangler d1 execute qti_auth --command="
SELECT * FROM recent_mod_actions LIMIT 100;
"
```

---

## Troubleshooting

| Issue                   | Solution                                                           |
| ----------------------- | ------------------------------------------------------------------ |
| "Database not found"    | Run migrations: `wrangler d1 execute qti_auth --file=./schema.sql` |
| OAuth redirect fails    | Check redirect URIs in OAuth provider settings                     |
| Magic link not arriving | Check email service API key and sending domain                     |
| "Unauthorized" errors   | Verify JWT_SECRET is set correctly                                 |
| Worker not deploying    | Run `wrangler whoami` to verify authentication                     |

---

## Resources

- **Cloudflare Docs**: https://developers.cloudflare.com
- **Hono Docs**: https://hono.dev
- **Wrangler CLI**: https://developers.cloudflare.com/workers/wrangler
