# QTI Auth System - Engineering Documentation

Technical reference for engineers working on the QTI Auth system.

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Authentication Flow](#authentication-flow)
3. [Database Schema](#database-schema)
4. [API Reference](#api-reference)
5. [Session Management](#session-management)
6. [User Reporting & Moderation](#user-reporting--moderation)
7. [Minecraft Integration (JagSMP)](#minecraft-integration-jagsmp)
8. [Security Model](#security-model)
9. [Rate Limiting](#rate-limiting)
10. [Error Handling](#error-handling)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                      Cloudflare Global Network                   │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐     ┌──────────────┐     ┌────────────────┐  │
│  │   Frontend   │     │    Worker    │     │       D1       │  │
│  │ React + Vite │────▶│  Hono API    │────▶│    SQLite      │  │
│  │   (Pages)    │     │              │     │  (Distributed) │  │
│  └──────────────┘     └──────────────┘     └────────────────┘  │
│                              │                                   │
│                              ▼                                   │
│                 ┌────────────────────────┐                      │
│                 │    External Services   │                      │
│                 │  - OAuth (Google/GH/DC)│                      │
│                 │  - Email (Brevo)       │                      │
│                 │  - Minecraft Plugin    │                      │
│                 └────────────────────────┘                      │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Technology Stack

| Component | Technology | Purpose |
|-----------|------------|---------|
| Backend | Cloudflare Workers + Hono | Serverless API |
| Database | Cloudflare D1 (SQLite) | Persistent storage |
| Frontend | React 18 + Vite | SPA with routing |
| Hosting | Cloudflare Pages | Static frontend |
| Auth | JWT + httpOnly cookies | Session tokens |
| Email | Brevo (formerly Sendinblue) | Magic links |

---

## Authentication Flow

### OAuth Flow (Google/GitHub/Discord)

```
User clicks "Sign in with Google"
        │
        ▼
┌─────────────────────────────────────────────────────────┐
│ 1. POST /auth/oauth/start                               │
│    - Generate random state                              │
│    - Store state in oauth_states table                  │
│    - Return provider auth URL with state                │
└─────────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────┐
│ 2. User completes OAuth at provider                     │
│    - Provider redirects to /auth/oauth/callback         │
│    - Callback includes code and state                   │
└─────────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────┐
│ 3. GET /auth/oauth/callback                             │
│    - Validate state from oauth_states                   │
│    - Exchange code for tokens at provider               │
│    - Fetch user info from provider                      │
│    - Create/find user in database                       │
│    - Generate JWT and set cookie                        │
│    - Redirect to frontend                               │
└─────────────────────────────────────────────────────────┘
```

### Magic Link Flow (Email)

```
User enters email + DOB
        │
        ▼
┌─────────────────────────────────────────────────────────┐
│ 1. POST /auth/email/start                               │
│    - Validate email format                              │
│    - Validate DOB (age check)                           │
│    - Check rate limits                                  │
│    - Generate token, hash and store in email_tokens     │
│    - Send email with magic link                         │
└─────────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────┐
│ 2. User clicks link in email                            │
│    - Link format: /verify?token={token}                 │
└─────────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────┐
│ 3. POST /auth/email/verify                              │
│    - Find token in email_tokens                         │
│    - Verify not expired (15 min)                        │
│    - Mark token as used                                 │
│    - Create/find user                                   │
│    - Generate JWT and set cookie                        │
└─────────────────────────────────────────────────────────┘
```

### Age Verification

Required for new accounts. Determines `is_child` flag.

```javascript
const isChild = age < 18;
const ageVerificationMethod = 'self_declaration'; // or 'oauth_birthday'
```

Child accounts (`is_child = 1`) receive:
- Enhanced content filtering
- Restricted access to certain features
- Cannot become moderators/admins

---

## Database Schema

### Core Tables

#### users
Primary user table with authentication and profile data.

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT | Primary key (UUID) |
| username_original | TEXT | Display username |
| username_canonical | TEXT | Lowercase for uniqueness |
| email | TEXT | User's email |
| oauth_provider | TEXT | google/github/discord/null |
| oauth_id | TEXT | Provider's user ID |
| role | TEXT | user/mod/admin |
| date_of_birth | TEXT | YYYY-MM-DD |
| is_child | INTEGER | 1 if under 18 |
| is_banned | INTEGER | 1 if banned |

#### user_sessions
Session tracking with security fingerprinting.

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT | Primary key (UUID) |
| user_id | TEXT | FK to users |
| token_hash | TEXT | SHA-256 of JWT |
| ip_address | TEXT | Client IP |
| ip_country | TEXT | GeoIP country |
| user_agent | TEXT | Browser UA |
| browser_fingerprint | TEXT | Client-side fingerprint |
| trust_level | TEXT | full/limited/suspicious |
| expires_at | INTEGER | Unix timestamp |
| revoked_at | INTEGER | Null if active |

#### user_reports
User-submitted reports for moderation.

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT | Primary key (UUID) |
| reporter_user_id | TEXT | Who reported |
| reported_user_id | TEXT | Who was reported |
| report_type | TEXT | Category (harassment, etc.) |
| priority | TEXT | low/medium/high/urgent |
| status | TEXT | pending/reviewed/actioned |
| content_snapshot | TEXT | Captured content |

### JagSMP Tables

See [JAGSMP_SETUP.md](JAGSMP_SETUP.md) for full schema:
- `minecraft_accounts`
- `minecraft_link_codes`
- `minecraft_player_stats`
- `minecraft_achievements`
- `minecraft_player_achievements`
- `minecraft_activity_log`

---

## API Reference

### Authentication Endpoints

```
POST /auth/oauth/start
  Body: { provider: "google"|"github"|"discord" }
  Returns: { url: "https://..." }

GET /auth/oauth/callback
  Query: code, state
  Sets cookie, redirects to frontend

POST /auth/email/start
  Body: { email, date_of_birth }
  Returns: { message: "Check your email" }

POST /auth/email/verify
  Body: { token }
  Sets cookie, returns user data

POST /auth/age/verify
  Body: { date_of_birth }
  Auth: Required
  Returns: { verified: true }

GET /me
  Auth: Required
  Returns: User object with profile data

POST /logout
  Auth: Required
  Clears cookie, revokes session
```

### Username Endpoints

```
POST /username/claim
  Auth: Required
  Body: { username }
  Returns: { username, message }

POST /username/change
  Auth: Required
  Body: { new_username }
  Returns: { username, message }
  Notes: 30-day cooldown, 3 changes/year max
```

### Session Endpoints

```
GET /sessions
  Auth: Required
  Returns: Array of active sessions

POST /sessions/:sessionId/revoke
  Auth: Required
  Returns: { message: "Session revoked" }

POST /sessions/revoke-all
  Auth: Required
  Revokes all sessions except current
```

### Reporting Endpoints

```
POST /report/user
  Auth: Required
  Body: {
    reported_user_id,
    report_type,
    report_subtype?,
    description
  }

POST /report/content
  Auth: Required
  Body: {
    content_id,
    content_type,
    report_type,
    description
  }

GET /report/status/:reportId
  Auth: Required
  Returns: Report status for reporter
```

### Moderation Endpoints (Admin Only)

```
GET /moderation/queue
  Auth: Admin
  Returns: Pending reports sorted by priority

POST /moderation/action
  Auth: Admin
  Body: {
    report_id,
    user_id,
    action_type: "warning"|"timeout"|"suspend"|"ban",
    reason,
    duration?,
    internal_notes?
  }

POST /moderation/dismiss
  Auth: Admin
  Body: { report_id, reason }
```

### Admin Endpoints

```
GET /admin/stats
  Auth: Admin
  Returns: Dashboard statistics

POST /admin/cleanup
  Auth: Admin
  Purges expired tokens, sessions, etc.

POST /admin/users/:userId/revoke-sessions
  Auth: Admin
  Force logout a user
```

### JagSMP Endpoints

```
GET /jagsmp/me
  Auth: Required
  Returns: Linked account, stats, achievements

POST /jagsmp/link
  Auth: Required
  Body: { code }
  Links Minecraft account via code

POST /jagsmp/unlink
  Auth: Required
  Unlinks account (7-day cooldown)

POST /jagsmp/generate-code (Plugin)
  Auth: MINECRAFT_PLUGIN_SECRET
  Body: { minecraft_uuid, minecraft_username }
  Returns: { code, expires_in_seconds }

POST /jagsmp/plugin/update-stats (Plugin)
  Auth: MINECRAFT_PLUGIN_SECRET
  Body: { minecraft_uuid, stats }
```

---

## Session Management

### Token Structure

JWT payload:
```javascript
{
  user_id: "uuid",
  role: "user",
  iat: 1234567890,
  exp: 1234567890
}
```

### Session Fingerprinting

Each session captures:
- IP address and /24 subnet
- User agent string and hash
- Browser fingerprint (from client)
- TLS fingerprint (from CF headers)
- Timezone, language, screen resolution

### Trust Levels

| Level | Description |
|-------|-------------|
| full | All fingerprints match, normal IP |
| limited | Minor fingerprint changes |
| suspicious | IP country change, significant fingerprint drift |

### Session Limits

- Max 10 concurrent sessions per user
- Sessions expire after 7 days
- Can be revoked individually or all at once
- Automatic cleanup removes expired sessions after 30 days

---

## User Reporting & Moderation

### Report Types

| Type | Priority | Description |
|------|----------|-------------|
| illegal_content | urgent | CSAM, terrorism content |
| harmful_to_child | urgent | Grooming, harmful content to minors |
| harassment | high | Targeted harassment |
| hate_speech | high | Discrimination, slurs |
| threats | high | Threats of violence |
| self_harm | high | Suicide/self-harm content |
| fraud | medium | Scams, phishing |
| spam | low | Unwanted advertising |

### Moderation Actions

| Action | Duration | Effect |
|--------|----------|--------|
| warning | N/A | Recorded, no restriction |
| timeout | 1-30 days | Cannot interact |
| suspend | 1-365 days | Cannot login |
| ban | Permanent | Account terminated |
| content_removal | N/A | Content deleted |

### SLA

Reports should be reviewed within 24 hours. Priority order:
1. Urgent (illegal, child safety)
2. High (harassment, threats)
3. Medium (fraud)
4. Low (spam)

---

## Minecraft Integration (JagSMP)

### Linking Flow

```
Player runs /qtilink in-game
        │
        ▼
Plugin calls POST /jagsmp/generate-code
        │
        ▼
Player gets 6-char code (expires 10 min)
        │
        ▼
Player enters code on website
        │
        ▼
POST /jagsmp/link verifies and links
```

### Stats Tracking

The Minecraft plugin periodically calls `/jagsmp/plugin/update-stats` with:
- Playtime (total minutes)
- Combat stats (kills, deaths, damage)
- Movement stats (distance walked, flown, etc.)
- Interaction stats (crafting, trading, etc.)

### Achievements

Achievements are unlocked via `/jagsmp/plugin/unlock-achievement`.

Categories:
- Combat
- Exploration
- Building
- Economy
- Social
- Secret

---

## Security Model

### JWT Security

- Signed with HS256
- Stored in httpOnly cookie (not localStorage)
- 7-day expiration
- Each token hashed and stored in session table

### Rate Limiting

| Endpoint | Limit |
|----------|-------|
| /auth/email/start | 3/hour per email |
| /auth/oauth/start | 10/hour per IP |
| /report/* | 5/hour per user |
| /username/change | 3/year per user |

### Input Validation

- Email: RFC 5322 regex
- Username: 8-18 chars, alphanumeric + underscore
- DOB: Valid date, age >= 13
- All SQL queries use parameterized bindings

### Content Filtering

Usernames checked against `banned_words` table:
- Exact match
- Regex patterns
- Severity levels (low/medium/high)

---

## Rate Limiting

Implemented via D1 with sliding window:

```javascript
// Check rate limit
const key = `${action}:${identifier}`;
const windowStart = now() - windowSize;

const count = await db.prepare(`
  SELECT COUNT(*) as count FROM rate_limits
  WHERE id = ? AND window_start > ?
`).bind(key, windowStart).first();

if (count >= limit) {
  return error(429, 'Rate limit exceeded');
}

// Record action
await db.prepare(`
  INSERT INTO rate_limits (id, action, window_start, expires_at)
  VALUES (?, ?, ?, ?)
`).bind(generateId(), key, now(), now() + windowSize).run();
```

---

## Error Handling

### HTTP Status Codes

| Code | Usage |
|------|-------|
| 200 | Success |
| 201 | Created |
| 400 | Bad request (validation) |
| 401 | Unauthorized (no token) |
| 403 | Forbidden (role check) |
| 404 | Not found |
| 409 | Conflict (duplicate) |
| 429 | Rate limited |
| 500 | Server error |

### Error Response Format

```json
{
  "error": "Human-readable error message",
  "code": "ERROR_CODE",
  "details": {}
}
```

### Common Error Codes

| Code | Description |
|------|-------------|
| INVALID_TOKEN | JWT invalid or expired |
| USERNAME_TAKEN | Username already exists |
| RATE_LIMITED | Too many requests |
| BANNED | User is banned |
| COOLDOWN_ACTIVE | Action on cooldown |
| INVALID_CODE | Link code invalid/expired |

---

## Scheduled Tasks

Configure in `wrangler.toml`:

```toml
[triggers]
crons = ["0 3 * * *"]  # Run at 3 AM UTC daily
```

The `handleScheduled` function cleans:
- Expired sessions (30+ days old)
- Old security events (90+ days)
- Expired OAuth states (1+ hour)
- Expired email tokens (24+ hours)
- Old rate limit entries (24+ hours)

---

## Local Development

### Prerequisites

```bash
npm install -g wrangler
wrangler login
```

### Setup

```bash
# Install deps
npm install
cd frontend && npm install && cd ..

# Create local D1
wrangler d1 execute qti_auth --local --file=./setup.sql

# Run worker
wrangler dev

# Run frontend (new terminal)
cd frontend && npm run dev
```

### Environment Variables

Worker (via wrangler.toml or secrets):
- `JWT_SECRET`
- `EMAIL_SERVICE_API_KEY`
- `GOOGLE_CLIENT_ID/SECRET`
- `GITHUB_CLIENT_ID/SECRET`
- `DISCORD_CLIENT_ID/SECRET`
- `MINECRAFT_PLUGIN_SECRET`

Frontend (`frontend/.env.local`):
- `VITE_API_URL`

---

## Deployment

### Worker

```bash
wrangler deploy
```

### Frontend

```bash
cd frontend
npm run build
wrangler pages deploy dist --project-name=qti-auth-frontend
```

### Database Migrations

```bash
# Apply schema
wrangler d1 execute qti_auth --file=./setup.sql

# Apply specific migration
wrangler d1 execute qti_auth --file=./migrations/0004_jagsmp_minecraft_linking.sql
```

---

## Monitoring

### Cloudflare Dashboard

- Worker analytics (requests, errors, latency)
- D1 analytics (queries, read/write units)
- Pages analytics (visits, bandwidth)

### Admin Dashboard

Access at `/mod/queue`:
- Pending reports count
- Reports by priority
- Recent moderation actions
- User statistics

### Useful Queries

```bash
# Total users
wrangler d1 execute qti_auth --command="SELECT COUNT(*) FROM users"

# Child users
wrangler d1 execute qti_auth --command="SELECT COUNT(*) FROM users WHERE is_child=1"

# Pending reports
wrangler d1 execute qti_auth --command="SELECT COUNT(*) FROM user_reports WHERE status='pending'"

# Recent moderation actions
wrangler d1 execute qti_auth --command="SELECT * FROM recent_mod_actions LIMIT 10"
```

