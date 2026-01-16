# QTI Auth System - Deployment Guide

## Overview

This is a complete, production-ready authentication system for QTI games, fully compliant with the UK Online Safety Act. It's built on Cloudflare's serverless infrastructure for maximum reliability and minimal operational overhead.

## Architecture

- **Backend**: Cloudflare Workers (Hono framework)
- **Database**: Cloudflare D1 (distributed SQLite)
- **Frontend**: React + Vite (deployed to Cloudflare Pages)
- **No servers**: 100% serverless, globally distributed

---

## Prerequisites

1. **Cloudflare Account** (free tier works for development)
2. **Node.js 18+** and npm
3. **Wrangler CLI**: `npm install -g wrangler`
4. **Domain** (optional for production, can use workers.dev for testing)

---

## Step 1: Database Setup

### Create D1 Database

```bash
cd /path/to/qti-auth
wrangler d1 create qti_auth
```

This outputs a database ID. Copy it and update `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "qti_auth"
database_id = "YOUR_DATABASE_ID_HERE"  # Paste the ID here
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

# OAuth provider credentials (optional - set these up later)
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
wrangler secret put GITHUB_CLIENT_ID
wrangler secret put GITHUB_CLIENT_SECRET
wrangler secret put DISCORD_CLIENT_ID
wrangler secret put DISCORD_CLIENT_SECRET

# Email service API key (e.g., SendGrid, Mailgun, Resend)
wrangler secret put EMAIL_SERVICE_API_KEY
```

### Update wrangler.toml

Edit environment variables in `wrangler.toml`:

```toml
[vars]
ENVIRONMENT = "production"
FRONTEND_URL = "https://auth.yourdomain.com"
API_URL = "https://api.yourdomain.com"
```

---

## Step 3: Deploy Worker

### Install Dependencies

```bash
npm install
```

### Deploy

```bash
# Deploy to production
wrangler deploy

# Or test locally first
wrangler dev
```

Your API will be available at:
- Production: `https://qti-auth.YOUR_SUBDOMAIN.workers.dev`
- Or custom domain: `https://api.yourdomain.com`

---

## Step 4: Frontend Setup

### Install Dependencies

```bash
cd frontend
npm install
```

### Configure Environment

Create `frontend/.env.local`:

```env
VITE_API_URL=https://api.yourdomain.com
```

For local development:

```env
VITE_API_URL=http://localhost:8787
```

### Build & Deploy

```bash
# Build
npm run build

# Deploy to Cloudflare Pages
npm run deploy
# OR manually:
wrangler pages deploy dist --project-name=qti-auth-frontend
```

Your frontend will be available at:
- `https://qti-auth-frontend.pages.dev`
- Or custom domain: `https://auth.yourdomain.com`

---

## Step 5: Custom Domains (Optional)

### Add Worker Route

In Cloudflare Dashboard:
1. Go to Workers & Pages → qti-auth
2. Click "Triggers" → "Add Custom Domain"
3. Enter: `api.yourdomain.com`

### Add Pages Custom Domain

1. Go to Pages → qti-auth-frontend
2. Click "Custom domains" → "Set up a custom domain"
3. Enter: `auth.yourdomain.com`

---

## Step 6: OAuth Setup

### Google OAuth

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create new project or select existing
3. Enable Google+ API
4. Create OAuth 2.0 credentials
5. Add authorized redirect URI: `https://api.yourdomain.com/auth/oauth/callback`
6. Set secrets: `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`

### GitHub OAuth

1. Go to GitHub Settings → Developer settings → OAuth Apps
2. Create new OAuth App
3. Authorization callback URL: `https://api.yourdomain.com/auth/oauth/callback`
4. Set secrets: `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`

### Discord OAuth

1. Go to [Discord Developer Portal](https://discord.com/developers)
2. Create new application
3. Go to OAuth2 → Add redirect: `https://api.yourdomain.com/auth/oauth/callback`
4. Set secrets: `DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET`

---

## Step 7: Email Service Setup

You need an email service to send magic links. Options:

### SendGrid

```bash
# Get API key from sendgrid.com
wrangler secret put EMAIL_SERVICE_API_KEY
```

Update `worker.js` to implement SendGrid email sending.

### Resend (Recommended)

```bash
# Get API key from resend.com
wrangler secret put EMAIL_SERVICE_API_KEY
```

Example integration in `worker.js`:

```javascript
async function sendMagicLink(email, token) {
  const magicLink = `${env.FRONTEND_URL}/verify?token=${token}`;
  
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.EMAIL_SERVICE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'QTI Auth <auth@yourdomain.com>',
      to: email,
      subject: 'Sign in to QTI',
      html: `
        <h1>Sign in to QTI</h1>
        <p>Click the link below to sign in:</p>
        <a href="${magicLink}">${magicLink}</a>
        <p>This link expires in 15 minutes.</p>
      `,
    }),
  });
}
```

---

## Step 8: Create First Admin Account

Admin accounts cannot be created through OAuth or signup. Create manually via Wrangler:

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

Then log in with the admin email to set up the account fully.

---

## Step 9: Testing

### Local Development

Terminal 1 - Run Worker:
```bash
wrangler dev
```

Terminal 2 - Run Frontend:
```bash
cd frontend
npm run dev
```

Visit `http://localhost:3000`

### Test Endpoints

```bash
# Health check
curl https://api.yourdomain.com/health

# Create account (magic link)
curl -X POST https://api.yourdomain.com/auth/email/start \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","date_of_birth":"2000-01-01"}'
```

---

## Step 10: Monitoring & Compliance

### Cloudflare Analytics

Monitor your Worker in the Cloudflare dashboard:
- Requests per second
- Error rates
- Response times

### Compliance Dashboard

Access admin dashboard at: `https://auth.yourdomain.com/mod/queue`

Key metrics to track:
- Pending reports (should be < 10)
- Reports actioned within 24h (UK OSA requirement)
- Child users as % of total
- Banned accounts

### Export Compliance Data

```bash
# Get daily stats for Ofcom reporting
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

## Production Checklist

Before going live, ensure:

- [ ] D1 database created and migrated
- [ ] All secrets set (JWT, OAuth, email)
- [ ] Custom domains configured
- [ ] First admin account created
- [ ] OAuth apps configured (Google, GitHub, Discord)
- [ ] Email service integrated
- [ ] ToS and Privacy Policy written and linked
- [ ] Children's risk assessment completed
- [ ] Illegal content risk assessment completed
- [ ] Banned words list expanded (see schema.sql)
- [ ] Moderation SLA documented (24h default)
- [ ] Backup strategy for D1 (export weekly via wrangler)

---

## Security Best Practices

1. **JWT Secret**: Use a strong random string (32+ chars)
2. **Rate Limiting**: Enable Cloudflare rate limiting rules
3. **Turnstile**: Add Cloudflare Turnstile to signup forms
4. **HTTPS Only**: Never allow HTTP in production
5. **Regular Audits**: Review moderation logs monthly
6. **Update Dependencies**: Keep wrangler and npm packages updated

---

## Backup & Recovery

### Backup D1 Database

```bash
# Export all data
wrangler d1 export qti_auth --output=backup.sql

# Schedule this weekly via cron
```

### Restore from Backup

```bash
wrangler d1 execute qti_auth --file=backup.sql
```

---

## Scaling

Cloudflare Workers scale automatically, but consider:

- **D1 Limits**: 
  - 25 GB storage (free tier: 5 GB)
  - 50 million reads/month (free tier: 5 million)
  - Contact Cloudflare for higher limits

- **Rate Limiting**: 
  - Implement per-user rate limits in code
  - Use Cloudflare Rate Limiting rules

- **Caching**: 
  - Cache username availability checks
  - Cache public user profiles
  - Use Cloudflare KV for frequently accessed data

---

## Troubleshooting

### "Database not found"
→ Run migrations: `wrangler d1 execute qti_auth --file=./schema.sql`

### OAuth redirect fails
→ Check redirect URIs in OAuth provider settings match exactly

### Magic link not arriving
→ Check email service API key and sending domain

### "Unauthorized" errors
→ Verify JWT_SECRET is set and matches between environments

### Worker not deploying
→ Run `wrangler whoami` to verify authentication
→ Check `wrangler.toml` syntax

---

## Support & Resources

- **Cloudflare Docs**: https://developers.cloudflare.com
- **Hono Docs**: https://hono.dev
- **UK OSA Guidance**: https://www.ofcom.org.uk/online-safety
- **Wrangler CLI**: https://developers.cloudflare.com/workers/wrangler

---

## Next Steps

After deployment:

1. **Test thoroughly** with real accounts
2. **Monitor** for the first week daily
3. **Expand banned words list** based on your community
4. **Train moderators** on the queue system
5. **Document** your moderation policies
6. **Schedule** weekly compliance reviews
7. **Plan** for Ofcom audit readiness

---

## License

This system is provided as-is for QTI games. Modify as needed for your specific requirements.

**Built with spite for servers, love for compliance.**
