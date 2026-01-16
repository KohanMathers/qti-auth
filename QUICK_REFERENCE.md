# QTI Auth - Quick Reference Card

## 🚀 Common Commands

### Development
```bash
# Run worker locally
wrangler dev

# Run frontend locally
cd frontend && npm run dev

# View worker logs
wrangler tail
```

### Deployment
```bash
# Deploy worker
wrangler deploy

# Deploy frontend
cd frontend && npm run build && wrangler pages deploy dist
```

### Database
```bash
# Run migrations
wrangler d1 execute qti_auth --file=./schema.sql

# Query database
wrangler d1 execute qti_auth --command="SELECT COUNT(*) FROM users"

# Backup database
wrangler d1 export qti_auth --output=backup.sql

# Restore database
wrangler d1 execute qti_auth --file=backup.sql
```

### Secrets
```bash
# Set a secret
wrangler secret put SECRET_NAME

# List secrets
wrangler secret list

# Delete a secret
wrangler secret delete SECRET_NAME
```

---

## 📊 Monitoring Queries

### User Stats
```sql
-- Total users
SELECT COUNT(*) as total_users FROM users;

-- Child users
SELECT COUNT(*) as child_users FROM users WHERE is_child = 1;

-- Banned users
SELECT COUNT(*) as banned_users FROM users WHERE is_banned = 1;

-- New users today
SELECT COUNT(*) as new_today FROM users 
WHERE created_at >= unixepoch('now', 'start of day');
```

### Moderation Stats
```sql
-- Pending reports
SELECT COUNT(*) as pending FROM user_reports WHERE status = 'pending';

-- Urgent reports
SELECT * FROM user_reports 
WHERE status = 'pending' AND priority = 'urgent'
ORDER BY created_at ASC;

-- Reports by type (last 30 days)
SELECT report_type, COUNT(*) as count 
FROM user_reports 
WHERE created_at >= unixepoch('now', '-30 days')
GROUP BY report_type;

-- Moderation actions (last 7 days)
SELECT action_type, COUNT(*) as count
FROM moderation_actions
WHERE created_at >= unixepoch('now', '-7 days')
GROUP BY action_type;
```

### Compliance Reporting
```sql
-- Daily stats (last 30 days)
SELECT * FROM daily_stats 
WHERE date >= date('now', '-30 days')
ORDER BY date DESC;

-- Average report resolution time
SELECT AVG(reviewed_at - created_at) / 3600 as avg_hours
FROM user_reports 
WHERE reviewed_at IS NOT NULL;

-- SLA compliance (% reviewed within 24h)
SELECT 
  COUNT(*) as total,
  SUM(CASE WHEN (reviewed_at - created_at) <= 86400 THEN 1 ELSE 0 END) as within_24h,
  CAST(SUM(CASE WHEN (reviewed_at - created_at) <= 86400 THEN 1 ELSE 0 END) AS FLOAT) / COUNT(*) * 100 as compliance_pct
FROM user_reports
WHERE reviewed_at IS NOT NULL
AND created_at >= unixepoch('now', '-30 days');
```

---

## 🔧 Admin Tasks

### Create Admin Account
```bash
wrangler d1 execute qti_auth --command="
INSERT INTO users (
  id, username_original, username_canonical, email, role,
  date_of_birth, is_child, age_verified_at, age_verification_method,
  created_at, updated_at
) VALUES (
  '$(uuidgen)',
  'QTI_YourName',
  'qti_yourname',
  'your@email.com',
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

### Ban User
```bash
wrangler d1 execute qti_auth --command="
UPDATE users 
SET is_banned = 1, ban_reason = 'Repeated ToS violations', banned_at = $(date +%s)
WHERE username_canonical = 'baduser';
"
```

### Unban User
```bash
wrangler d1 execute qti_auth --command="
UPDATE users 
SET is_banned = 0, ban_reason = NULL, banned_at = NULL
WHERE username_canonical = 'gooduser';
"
```

### Add Banned Word
```bash
wrangler d1 execute qti_auth --command="
INSERT INTO banned_words (word, severity, category, created_at)
VALUES ('newbadword', 'high', 'slur', $(date +%s));
"
```

### Export Compliance Data
```bash
# All reports (last 12 months)
wrangler d1 execute qti_auth --command="
SELECT * FROM user_reports 
WHERE created_at >= unixepoch('now', '-12 months')
" --json > reports_12mo.json

# All moderation actions (last 12 months)
wrangler d1 execute qti_auth --command="
SELECT * FROM moderation_actions 
WHERE created_at >= unixepoch('now', '-12 months')
" --json > actions_12mo.json
```

---

## 🐛 Troubleshooting

### "Database not found"
```bash
# Re-run migrations
wrangler d1 execute qti_auth --file=./schema.sql
```

### "Unauthorized" on /me endpoint
```bash
# Check JWT_SECRET is set
wrangler secret list

# If not, set it
wrangler secret put JWT_SECRET
```

### Worker deployment fails
```bash
# Verify you're logged in
wrangler whoami

# If not, log in
wrangler login
```

### Frontend shows "Network Error"
```bash
# Check API_URL in frontend/.env.local
cat frontend/.env.local

# Should match your deployed worker URL
# Local: http://localhost:8787
# Production: https://api.yourdomain.com
```

### Magic links not sending
```bash
# Check email service API key is set
wrangler secret list

# Verify implementation in worker.js
# Search for "sendMagicLink" function
```

---

## 📈 Performance Optimization

### Check Worker Performance
```bash
# View real-time logs with timing
wrangler tail --format=pretty
```

### Optimize D1 Queries
```sql
-- Check if indexes are being used
EXPLAIN QUERY PLAN SELECT * FROM users WHERE email_normalized = 'test@example.com';

-- Should show "USING INDEX idx_users_email_normalized"
```

### Cache Username Checks
Use Cloudflare KV for frequently checked usernames:
```javascript
// In worker.js, add:
const cached = await env.KV.get(`username:${canonical}`);
if (cached === 'taken') return { available: false };
```

---

## 🔐 Security Checklist

- [ ] JWT_SECRET is strong (32+ chars)
- [ ] All OAuth redirect URIs use HTTPS
- [ ] Rate limiting enabled on auth endpoints
- [ ] Cloudflare Turnstile added to signup forms
- [ ] D1 database backups scheduled weekly
- [ ] Admin accounts use 2FA (future feature)
- [ ] Secrets never in version control
- [ ] HTTPS-only (no HTTP allowed)

---

## 📞 Emergency Procedures

### CSAM Report
1. **DO NOT VIEW CONTENT**
2. Ban user immediately
3. Report to IWF: https://report.iwf.org.uk
4. Preserve evidence
5. Document in admin_logs

### Service Outage
1. Check Cloudflare status: https://www.cloudflarestatus.com
2. View worker logs: `wrangler tail`
3. Rollback if needed: `wrangler rollback`
4. Contact Cloudflare support if infrastructure issue

### Data Breach
1. Assess scope (what data exposed)
2. Notify affected users (GDPR requirement)
3. Report to ICO (UK): https://ico.org.uk/for-organisations/report-a-breach
4. Document incident
5. Fix vulnerability
6. Rotate JWT_SECRET if compromised

---

## 📚 Resources

- **Cloudflare Docs**: https://developers.cloudflare.com
- **Wrangler CLI**: https://developers.cloudflare.com/workers/wrangler
- **UK OSA Guidance**: https://www.ofcom.org.uk/online-safety
- **D1 Documentation**: https://developers.cloudflare.com/d1

---

## 💡 Quick Tips

- Use `wrangler dev --local` to test without hitting production D1
- Add `--json` to D1 queries for easier parsing
- Set `wrangler tail --format=pretty` for readable logs
- Use views (in schema.sql) for complex queries
- Bookmark the moderation queue: `/mod/queue`
- Export compliance data monthly, not just when Ofcom asks
- Test magic links in incognito mode
- Keep wrangler updated: `npm update -g wrangler`

---

**Last Updated**: January 2025
**Version**: 1.0.0
