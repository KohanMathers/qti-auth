# QTI Auth System

**Serverless, spite-driven authentication for QTI games. UK Online Safety Act compliant. No passwords, no servers, no 3am fires.**

---

## What Is This?

A complete authentication system for QTI's multiplayer games, built on Cloudflare's edge infrastructure. It handles user accounts, age verification, content moderation, and regulatory compliance—all without a single server to maintain.

### Key Features

✓ **Passwordless authentication** (OAuth + email magic links)  
✓ **Age verification** (UK OSA requirement)  
✓ **Child safety protections** (enhanced security for under-18s)  
✓ **User reporting system** (illegal/harmful content)  
✓ **Admin moderation queue** (24-hour SLA)  
✓ **Complete audit trail** (Ofcom-ready)  
✓ **100% serverless** (Cloudflare Workers + D1 + Pages)  
✓ **Globally distributed** (low latency everywhere)  
✓ **Zero passwords** (nothing to leak)  

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Cloudflare Edge                      │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  ┌──────────────┐    ┌──────────────┐    ┌───────────┐ │
│  │   Frontend   │    │    Worker    │    │    D1     │ │
│  │ (React/Vite) │───▶│    (Hono)    │───▶│  (SQLite) │ │
│  │   on Pages   │    │     API      │    │ Distributed│ │
│  └──────────────┘    └──────────────┘    └───────────┘ │
│                                                          │
│  ┌──────────────────────────────────────────────────┐  │
│  │        OAuth Providers (Google/GitHub/Discord)    │  │
│  └──────────────────────────────────────────────────┘  │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

---

## Quick Start

### Prerequisites

- Node.js 18+
- Cloudflare account (free tier works)
- Wrangler CLI: `npm install -g wrangler`

### Setup (5 minutes)

```bash
# 1. Clone/download this repo
cd qti-auth

# 2. Install dependencies
npm install

# 3. Create D1 database
wrangler d1 create qti_auth
# Copy the database ID into wrangler.toml

# 4. Run migrations
wrangler d1 execute qti_auth --file=./schema.sql

# 5. Set JWT secret
wrangler secret put JWT_SECRET
# Enter a strong random string

# 6. Deploy worker
wrangler deploy

# 7. Deploy frontend
cd frontend
npm install
npm run build
wrangler pages deploy dist --project-name=qti-auth-frontend
```

**Done.** Your auth system is live.

Full deployment guide: [DEPLOYMENT.md](DEPLOYMENT.md)

---

## File Structure

```
qti-auth/
├── schema.sql              # D1 database schema (users, reports, moderation)
├── worker.js               # Cloudflare Worker API (Hono framework)
├── wrangler.toml           # Worker configuration
├── package.json            # Worker dependencies
├── DEPLOYMENT.md           # Full deployment guide
├── UK_OSA_COMPLIANCE.md    # Compliance checklist
├── frontend/
│   ├── src/
│   │   ├── App.jsx         # React app with routing
│   │   ├── App.css         # Styling
│   │   ├── pages/
│   │   │   ├── Login.jsx           # Login/signup page
│   │   │   ├── ClaimUsername.jsx   # Username selection
│   │   │   ├── Dashboard.jsx       # User profile
│   │   │   └── ModQueue.jsx        # Admin moderation queue
│   ├── package.json        # Frontend dependencies
│   └── vite.config.js      # Vite config
└── README.md               # This file
```

---

## Usage

### User Flow

1. **Sign up/Login**
   - OAuth (Google/GitHub/Discord) or email magic link
   - Provide date of birth (age verification)
   - System calculates age → sets `is_child` flag

2. **Choose username**
   - 8-18 characters, letters/numbers/underscore
   - Cannot start with `QTI_` (reserved for admins)
   - Profanity checked
   - Case-insensitive uniqueness

3. **Use QTI games**
   - Session token contains `is_child` flag
   - Game servers apply appropriate content filters
   - Users can report harmful content in-game

### Admin Flow

1. **Access moderation queue**
   - Navigate to `/mod/queue`
   - View pending reports sorted by priority

2. **Review report**
   - See reporter, reported user, content snapshot
   - View report type (harassment, hate speech, etc.)

3. **Take action**
   - Warning, timeout, suspend, ban, or dismiss
   - Provide reason (visible to user)
   - Add internal notes (admin only)

4. **System logs action**
   - Saved in `moderation_actions` table
   - Audit trail for Ofcom compliance

---

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
POST   /report/content          Report specific content
GET    /report/status/:id       Check report status

GET    /moderation/queue        View pending reports (admin)
GET    /moderation/report/:id   Get report details (admin)
POST   /moderation/action       Take action on report (admin)
POST   /moderation/dismiss      Dismiss report (admin)
```

### Admin

```
GET    /admin/stats             Dashboard statistics (admin)
```

Full API documentation in [worker.js](worker.js) comments.

---

## UK Online Safety Act Compliance

This system is designed to comply with the UK Online Safety Act from day one.

### Built-In Compliance Features

✓ **Age verification** (required at signup)  
✓ **Child safety duties** (enhanced protections for under-18s)  
✓ **Illegal content duties** (reporting + moderation systems)  
✓ **User reporting** (easy-to-use report buttons)  
✓ **Moderation queue** (24-hour review SLA)  
✓ **Audit trail** (all actions logged)  
✓ **ToS enforcement** (clear rules, consistent application)  

### What You Still Need To Do

Before launch:

1. Write **Terms of Service** and **Privacy Policy**
2. Complete **Children's Risk Assessment** (deadline: 24 July 2025)
3. Complete **Illegal Content Risk Assessment** (required NOW)
4. Expand **banned words list** for your community
5. Train **moderators** on queue usage
6. Set up **email service** (SendGrid/Resend/etc)

Full checklist: [UK_OSA_COMPLIANCE.md](UK_OSA_COMPLIANCE.md)

---

## Security Features

- **No passwords stored** (passwordless authentication)
- **JWT sessions** (HMAC-signed, 7-day expiry)
- **Rate limiting** (anti-spam, anti-abuse)
- **Email normalization** (prevents duplicate accounts via email tricks)
- **Username history** (prevents impersonation)
- **Profanity filtering** (at signup and content level)
- **Child account flagging** (automatic based on age)
- **OAuth-only admin creation** (admins cannot be socially engineered via signup)

---

## Customization

### Add More OAuth Providers

Edit `worker.js` to add Apple, Microsoft, etc.:

```javascript
const redirectUrls = {
  google: 'https://accounts.google.com/o/oauth2/v2/auth',
  github: 'https://github.com/login/oauth/authorize',
  discord: 'https://discord.com/api/oauth2/authorize',
  apple: 'https://appleid.apple.com/auth/authorize',  // Add this
};
```

Then set up OAuth app and add secrets.

### Customize Username Rules

Edit in `worker.js`:

```javascript
const CONFIG = {
  USERNAME_MIN_LENGTH: 8,     // Change to 6 or 10
  USERNAME_MAX_LENGTH: 18,    // Change to 20 or 16
  USERNAME_CHANGE_COOLDOWN: 30 * 24 * 60 * 60,  // 30 days
  MAX_USERNAME_CHANGES_PER_YEAR: 3,
  ADMIN_PREFIX: 'QTI_',       // Change to 'ADMIN_' or 'MOD_'
};
```

### Add More Banned Words

Edit `schema.sql` to add words to the `banned_words` table:

```sql
INSERT INTO banned_words (word, severity, category, created_at) VALUES
('newbadword', 'high', 'slur', unixepoch());
```

Then re-run migration.

### Adjust Report Types

Edit `REPORT_TYPES` and `REPORT_SUBTYPES` in `worker.js` to match your community needs.

---

## Monitoring

### Cloudflare Dashboard

Track in real-time:
- Requests per second
- Error rates
- Response times
- Database queries

### Admin Stats

Access via API or dashboard:

```bash
curl https://api.yourdomain.com/admin/stats \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

Returns:
- Total users
- Child users (%)
- Banned users
- Pending reports
- Daily stats (last 30 days)

### Logs

View Worker logs:

```bash
wrangler tail
```

Export D1 data:

```bash
wrangler d1 execute qti_auth --command="SELECT * FROM daily_stats" --json
```

---

## Scaling

Cloudflare Workers scale automatically to millions of requests, but:

### D1 Limits (Free Tier)

- 5 GB storage
- 5 million reads/month
- 100,000 writes/day

### When to Upgrade

- **10,000+ users**: Upgrade to Workers Paid ($5/month)
- **100,000+ users**: Contact Cloudflare for D1 limits increase
- **1M+ users**: Consider sharding D1 by region

### Optimization Tips

- Cache username availability checks (KV)
- Batch report queries
- Use indexes (already in schema)
- Archive old moderation logs (yearly)

---

## Backup & Recovery

### Weekly Backup (Recommended)

```bash
# Export full database
wrangler d1 export qti_auth --output=backup-$(date +%Y%m%d).sql

# Automate via cron:
0 3 * * 0 cd /path/to/qti-auth && wrangler d1 export qti_auth --output=backup-$(date +%Y%m%d).sql
```

### Restore from Backup

```bash
wrangler d1 execute qti_auth --file=backup-20250109.sql
```

### Disaster Recovery

1. D1 database is automatically replicated across Cloudflare's edge
2. Worker code is versioned (rollback via Wrangler)
3. Frontend is static files (atomic deploys on Pages)

**No single point of failure.**

---

## Troubleshooting

### Common Issues

**"Database not found"**
→ Run migrations: `wrangler d1 execute qti_auth --file=./schema.sql`

**"Unauthorized" errors**
→ Check JWT_SECRET is set: `wrangler secret list`

**Magic link not arriving**
→ Verify email service API key and implementation

**OAuth redirect fails**
→ Check redirect URI matches in OAuth provider settings

**Worker won't deploy**
→ Verify wrangler is logged in: `wrangler whoami`

Full troubleshooting guide: [DEPLOYMENT.md](DEPLOYMENT.md)

---

## Development

### Local Development

```bash
# Terminal 1: Run worker locally
wrangler dev

# Terminal 2: Run frontend
cd frontend
npm run dev
```

Visit `http://localhost:3000`

### Testing

```bash
# Test health endpoint
curl http://localhost:8787/health

# Test email signup
curl -X POST http://localhost:8787/auth/email/start \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","date_of_birth":"2000-01-01"}'
```

### Database Console

```bash
# Query D1 directly
wrangler d1 execute qti_auth --command="SELECT COUNT(*) FROM users"

# Interactive SQL shell (local)
wrangler d1 execute qti_auth --local --command=".mode table"
```

---

## Contributing

This is an internal QTI project, but if you spot bugs or have suggestions:

1. Open an issue
2. Submit a pull request
3. Message the team on Discord

**Focus areas for improvement:**
- More OAuth providers
- Better email templates
- Enhanced content moderation (ML/AI)
- Multi-language support

---

## License

Copyright © 2025 QTI Games. All rights reserved.

This code is provided for QTI's internal use. Modify as needed for your games.

---

## Credits

Built with:
- [Cloudflare Workers](https://workers.cloudflare.com)
- [Cloudflare D1](https://developers.cloudflare.com/d1)
- [Cloudflare Pages](https://pages.cloudflare.com)
- [Hono](https://hono.dev) (lightweight web framework)
- [React](https://react.dev)
- [Vite](https://vitejs.dev)

Compliance guidance:
- [UK Online Safety Act](https://www.legislation.gov.uk/ukpga/2023/50)
- [Ofcom](https://www.ofcom.org.uk/online-safety)

---

## Support

- **Documentation**: [DEPLOYMENT.md](DEPLOYMENT.md), [UK_OSA_COMPLIANCE.md](UK_OSA_COMPLIANCE.md)
- **Issues**: Open an issue in this repo
- **Cloudflare Docs**: https://developers.cloudflare.com
- **Discord**: #qti-auth channel

---

**Built with spite for servers, love for compliance, and a deep appreciation for things that just work.**

🚀 **Now go ship it.**
