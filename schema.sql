-- QTI Auth System - D1 Database Schema
-- UK Online Safety Act Compliant
-- Version: 1.0.0

-- ============================================================================
-- CORE TABLES
-- ============================================================================

-- Users table with age verification and compliance fields
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,                    -- UUID, immutable forever
  username_original TEXT UNIQUE,          -- Display name with case preserved
  username_canonical TEXT UNIQUE,         -- Lowercase for uniqueness checks
  email TEXT,                              -- Nullable (OAuth-only users)
  email_normalized TEXT,                   -- Stripped for duplicate detection
  oauth_provider TEXT,                     -- "google", "github", "discord", null for email
  oauth_id TEXT,                           -- Provider's user ID
  role TEXT DEFAULT 'user',                -- "user" or "admin"
  
  -- UK OSA Compliance fields
  date_of_birth TEXT NOT NULL,             -- ISO date format (YYYY-MM-DD)
  is_child INTEGER NOT NULL DEFAULT 0,     -- Boolean: 1 if under 18
  age_verified_at INTEGER NOT NULL,        -- Unix timestamp when age was verified
  age_verification_method TEXT NOT NULL,   -- "oauth", "self_declaration", "third_party"
  parental_consent INTEGER DEFAULT 0,      -- Boolean: for users 13-17 if needed
  
  -- ToS and policy tracking
  tos_accepted_at INTEGER,                 -- When user accepted Terms of Service
  tos_version TEXT,                        -- Version of ToS accepted
  
  -- Account status
  is_banned INTEGER DEFAULT 0,             -- Boolean: account banned
  ban_reason TEXT,                         -- Reason for ban
  banned_at INTEGER,                       -- When banned
  banned_by TEXT,                          -- Admin user_id who banned
  
  -- Timestamps
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  
  -- Indexes
  UNIQUE(oauth_provider, oauth_id)
);

CREATE INDEX IF NOT EXISTS idx_users_email_normalized ON users(email_normalized);
CREATE INDEX IF NOT EXISTS idx_users_username_canonical ON users(username_canonical);
CREATE INDEX IF NOT EXISTS idx_users_oauth ON users(oauth_provider, oauth_id);
CREATE INDEX IF NOT EXISTS idx_users_is_child ON users(is_child);
CREATE INDEX IF NOT EXISTS idx_users_is_banned ON users(is_banned);

-- ============================================================================
-- USERNAME MANAGEMENT
-- ============================================================================

-- Username history (audit trail for all username changes)
CREATE TABLE IF NOT EXISTS username_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  old_username TEXT,                       -- Null on initial claim
  new_username TEXT NOT NULL,
  changed_at INTEGER NOT NULL,
  changed_reason TEXT,                     -- "initial_claim", "user_change", "admin_change"
  
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_username_history_user ON username_history(user_id);
CREATE INDEX IF NOT EXISTS idx_username_history_changed_at ON username_history(changed_at);

-- Username change cooldowns
CREATE TABLE IF NOT EXISTS username_cooldowns (
  user_id TEXT PRIMARY KEY,
  last_change_at INTEGER NOT NULL,
  change_count_this_year INTEGER DEFAULT 1,
  year INTEGER NOT NULL,                   -- Year for counting changes
  
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ============================================================================
-- SESSION MANAGEMENT (Enhanced Security)
-- ============================================================================

-- Active user sessions with fingerprint tracking
CREATE TABLE IF NOT EXISTS user_sessions (
  id TEXT PRIMARY KEY,                     -- Session UUID
  user_id TEXT NOT NULL,                   -- User this session belongs to

  -- Token info
  token_hash TEXT NOT NULL,                -- SHA-256 hash of JWT for revocation

  -- IP/Network tracking
  ip_address TEXT NOT NULL,                -- Client IP at session creation
  ip_subnet TEXT NOT NULL,                 -- /24 subnet for loose matching (e.g., "192.168.1")
  ip_country TEXT,                         -- Country code from IP geolocation

  -- Browser fingerprinting
  user_agent TEXT,                         -- Full User-Agent string
  user_agent_hash TEXT,                    -- Hash of User-Agent for quick comparison
  browser_fingerprint TEXT,                -- Hash of canvas/WebGL/fonts fingerprint
  tls_fingerprint TEXT,                    -- JA3/JA4 TLS fingerprint (from Cloudflare)
  timezone TEXT,                           -- Client timezone (e.g., "Europe/London")
  screen_resolution TEXT,                  -- Screen resolution (e.g., "1920x1080")
  language TEXT,                           -- Accept-Language header

  -- Session metadata
  auth_method TEXT NOT NULL,               -- "email", "oauth_google", "oauth_github", "oauth_discord"
  device_type TEXT,                        -- "desktop", "mobile", "tablet"

  -- Security flags
  trust_level TEXT DEFAULT 'full',         -- "full", "partial", "suspicious", "blocked"
  flagged_at INTEGER,                      -- When session was flagged
  flag_reason TEXT,                        -- Why it was flagged

  -- Timestamps
  created_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,                      -- Set when session is invalidated

  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_token_hash ON user_sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_user_sessions_expires ON user_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_user_sessions_ip ON user_sessions(ip_address);
CREATE INDEX IF NOT EXISTS idx_user_sessions_trust ON user_sessions(trust_level);
CREATE INDEX IF NOT EXISTS idx_user_sessions_revoked ON user_sessions(revoked_at);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user_active ON user_sessions(user_id, revoked_at, expires_at);

-- Session security events (audit trail)
CREATE TABLE IF NOT EXISTS session_security_events (
  id TEXT PRIMARY KEY,
  session_id TEXT,                         -- May be null if session creation failed
  user_id TEXT,
  event_type TEXT NOT NULL,                -- "new_session", "fingerprint_mismatch", "ip_change", "country_change", "forced_reauth", "blocked"
  ip_address TEXT,
  ip_country TEXT,
  details TEXT,                            -- JSON with event details
  created_at INTEGER NOT NULL,

  FOREIGN KEY (session_id) REFERENCES user_sessions(id) ON DELETE SET NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_session_events_user ON session_security_events(user_id);
CREATE INDEX IF NOT EXISTS idx_session_events_session ON session_security_events(session_id);
CREATE INDEX IF NOT EXISTS idx_session_events_type ON session_security_events(event_type);
CREATE INDEX IF NOT EXISTS idx_session_events_created ON session_security_events(created_at);

-- ============================================================================
-- EMAIL AUTHENTICATION
-- ============================================================================

-- Email verification tokens (magic links)
CREATE TABLE IF NOT EXISTS email_tokens (
  id TEXT PRIMARY KEY,                     -- Random token
  email TEXT NOT NULL,
  email_normalized TEXT NOT NULL,
  token_hash TEXT NOT NULL,                -- Hashed token for security
  date_of_birth TEXT NOT NULL,             -- User's submitted DoB
  expires_at INTEGER NOT NULL,
  used INTEGER DEFAULT 0,                  -- Boolean: token used
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_email_tokens_hash ON email_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_email_tokens_expires ON email_tokens(expires_at);

-- ============================================================================
-- OAUTH TEMPORARY DATA
-- ============================================================================

-- OAuth state parameter tracking (CSRF protection)
CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,                  -- Random state UUID
  provider TEXT NOT NULL,                  -- "google", "github", "discord"
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oauth_states_created ON oauth_states(created_at);

-- Temporary OAuth data (when age verification is needed)
CREATE TABLE IF NOT EXISTS oauth_temp (
  id TEXT PRIMARY KEY,                     -- Temp token UUID
  provider TEXT NOT NULL,                  -- OAuth provider
  oauth_id TEXT NOT NULL,                  -- Provider's user ID
  email TEXT,                              -- User's email from provider
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oauth_temp_created ON oauth_temp(created_at);

-- ============================================================================
-- RATE LIMITING
-- ============================================================================

-- Email/IP rate limit tracking
CREATE TABLE IF NOT EXISTS mail_rate_limits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,                       -- Rate limit key (e.g., "email_auth:email@example.com")
  timestamp INTEGER NOT NULL               -- When the request occurred
);

CREATE INDEX IF NOT EXISTS idx_mail_rate_limits_key ON mail_rate_limits(key);
CREATE INDEX IF NOT EXISTS idx_mail_rate_limits_timestamp ON mail_rate_limits(timestamp);

-- ============================================================================
-- UK ONLINE SAFETY ACT COMPLIANCE TABLES
-- ============================================================================

-- User reports (required for illegal content duties)
CREATE TABLE IF NOT EXISTS user_reports (
  id TEXT PRIMARY KEY,
  reporter_user_id TEXT,                   -- Who reported (null if anonymous)
  reported_user_id TEXT,                   -- Who was reported
  reported_content_id TEXT,                -- Reference to chat/content
  content_type TEXT,                       -- "text_message", "voice_chat", "username", "image", etc
  report_type TEXT NOT NULL,               -- "illegal_content", "harmful_to_child", "harassment", etc
  report_subtype TEXT,                     -- Specific violation: "hate_speech", "threat", "self_harm", etc
  description TEXT,                        -- User's description
  status TEXT DEFAULT 'pending',           -- "pending", "under_review", "actioned", "dismissed"
  priority TEXT DEFAULT 'medium',          -- "low", "medium", "high", "urgent"
  
  -- Review tracking
  reviewed_at INTEGER,
  reviewed_by TEXT,                        -- Admin user_id
  review_notes TEXT,                       -- Internal notes
  
  -- Evidence
  content_snapshot TEXT,                   -- Copy of reported content
  metadata TEXT,                           -- JSON: IP, timestamp, context, etc
  
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  
  FOREIGN KEY (reported_user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_reports_status ON user_reports(status);
CREATE INDEX IF NOT EXISTS idx_reports_reported_user ON user_reports(reported_user_id);
CREATE INDEX IF NOT EXISTS idx_reports_reporter ON user_reports(reporter_user_id);
CREATE INDEX IF NOT EXISTS idx_reports_created ON user_reports(created_at);
CREATE INDEX IF NOT EXISTS idx_reports_priority ON user_reports(priority);

-- Moderation actions (audit trail for Ofcom)
CREATE TABLE IF NOT EXISTS moderation_actions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,                   -- Target user
  moderator_id TEXT NOT NULL,              -- Admin who took action
  action_type TEXT NOT NULL,               -- "warning", "timeout", "suspend", "ban", "content_removal", "unban"
  duration INTEGER,                        -- For temporary actions (seconds)
  reason TEXT NOT NULL,
  related_report_id TEXT,                  -- Link to report if applicable
  internal_notes TEXT,                     -- Admin notes
  created_at INTEGER NOT NULL,
  expires_at INTEGER,                      -- For temporary actions
  
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (moderator_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (related_report_id) REFERENCES user_reports(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_mod_actions_user ON moderation_actions(user_id);
CREATE INDEX IF NOT EXISTS idx_mod_actions_moderator ON moderation_actions(moderator_id);
CREATE INDEX IF NOT EXISTS idx_mod_actions_created ON moderation_actions(created_at);
CREATE INDEX IF NOT EXISTS idx_mod_actions_type ON moderation_actions(action_type);

-- Content flags (for future image/video moderation)
CREATE TABLE IF NOT EXISTS content_flags (
  id TEXT PRIMARY KEY,
  content_id TEXT NOT NULL,
  content_type TEXT NOT NULL,              -- "text", "image", "video", "voice"
  user_id TEXT,                            -- Content owner
  flagged_by TEXT NOT NULL,                -- "user_report", "automated", "moderator"
  flag_reason TEXT NOT NULL,
  severity TEXT DEFAULT 'medium',          -- "low", "medium", "high", "critical"
  status TEXT DEFAULT 'pending',           -- "pending", "reviewed", "removed", "cleared"
  automated_score REAL,                    -- If using ML/AI moderation
  content_hash TEXT,                       -- For deduplication
  reviewed_at INTEGER,
  reviewed_by TEXT,
  created_at INTEGER NOT NULL,
  
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_content_flags_status ON content_flags(status);
CREATE INDEX IF NOT EXISTS idx_content_flags_user ON content_flags(user_id);
CREATE INDEX IF NOT EXISTS idx_content_flags_created ON content_flags(created_at);
CREATE INDEX IF NOT EXISTS idx_content_flags_severity ON content_flags(severity);

-- ============================================================================
-- SAFETY & ABUSE PREVENTION
-- ============================================================================

-- Profanity/banned words list
CREATE TABLE IF NOT EXISTS banned_words (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  word TEXT NOT NULL UNIQUE,
  severity TEXT DEFAULT 'medium',          -- "low", "medium", "high"
  category TEXT,                           -- "profanity", "slur", "hate_speech", "threat", etc
  case_sensitive INTEGER DEFAULT 0,        -- Boolean
  is_regex INTEGER DEFAULT 0,              -- Boolean: treat as regex pattern
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_banned_words_word ON banned_words(word);
CREATE INDEX IF NOT EXISTS idx_banned_words_severity ON banned_words(severity);

-- Rate limiting (anti-spam, anti-abuse)
CREATE TABLE IF NOT EXISTS rate_limits (
  id TEXT PRIMARY KEY,                     -- user_id:action or ip:action
  action TEXT NOT NULL,                    -- "auth_attempt", "report_submit", "username_change", etc
  count INTEGER DEFAULT 1,
  window_start INTEGER NOT NULL,           -- Unix timestamp
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_expires ON rate_limits(expires_at);

-- ============================================================================
-- ADMIN & AUDIT
-- ============================================================================

-- Admin activity log
CREATE TABLE IF NOT EXISTS admin_logs (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL,
  action TEXT NOT NULL,                    -- "ban_user", "review_report", "update_user", etc
  target_id TEXT,                          -- ID of affected resource
  target_type TEXT,                        -- "user", "report", "content", etc
  details TEXT,                            -- JSON with full context
  ip_address TEXT,
  created_at INTEGER NOT NULL,
  
  FOREIGN KEY (admin_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_logs_admin ON admin_logs(admin_id);
CREATE INDEX IF NOT EXISTS idx_admin_logs_created ON admin_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_admin_logs_action ON admin_logs(action);

-- ============================================================================
-- STATISTICS & COMPLIANCE REPORTING
-- ============================================================================

-- Daily stats for compliance reporting
CREATE TABLE IF NOT EXISTS daily_stats (
  date TEXT PRIMARY KEY,                   -- YYYY-MM-DD
  new_users INTEGER DEFAULT 0,
  child_users_created INTEGER DEFAULT 0,
  reports_submitted INTEGER DEFAULT 0,
  reports_actioned INTEGER DEFAULT 0,
  accounts_banned INTEGER DEFAULT 0,
  content_removed INTEGER DEFAULT 0,
  updated_at INTEGER NOT NULL
);

-- ============================================================================
-- INITIAL DATA
-- ============================================================================

-- Insert some common banned words (starter set - expand this)
INSERT OR IGNORE INTO banned_words (word, severity, category, created_at) VALUES
-- Slurs and hate speech (high severity)
('nigger', 'high', 'slur', unixepoch()),
('faggot', 'high', 'slur', unixepoch()),
('tranny', 'high', 'slur', unixepoch()),
('kike', 'high', 'slur', unixepoch()),
('chink', 'high', 'slur', unixepoch()),

-- Threats and violence (high severity)
('kill yourself', 'high', 'threat', unixepoch()),
('kys', 'high', 'threat', unixepoch()),
('die', 'medium', 'threat', unixepoch()),

-- Self-harm (high severity)
('suicide', 'high', 'self_harm', unixepoch()),
('cut myself', 'high', 'self_harm', unixepoch()),

-- Common profanity (medium/low severity)
('fuck', 'medium', 'profanity', unixepoch()),
('shit', 'medium', 'profanity', unixepoch()),
('cunt', 'high', 'profanity', unixepoch()),
('bitch', 'medium', 'profanity', unixepoch()),

-- Spam/scam indicators (medium severity)
('free robux', 'medium', 'scam', unixepoch()),
('click here', 'low', 'spam', unixepoch()),
('dm me', 'low', 'spam', unixepoch());

-- ============================================================================
-- VIEWS FOR COMMON QUERIES
-- ============================================================================

-- Active child users
CREATE VIEW IF NOT EXISTS active_child_users AS
SELECT id, username_original, date_of_birth, age_verification_method, created_at
FROM users
WHERE is_child = 1 AND is_banned = 0;

-- Pending reports
CREATE VIEW IF NOT EXISTS pending_reports AS
SELECT 
  r.*,
  u1.username_original as reporter_username,
  u2.username_original as reported_username
FROM user_reports r
LEFT JOIN users u1 ON r.reporter_user_id = u1.id
LEFT JOIN users u2 ON r.reported_user_id = u2.id
WHERE r.status = 'pending'
ORDER BY 
  CASE r.priority
    WHEN 'urgent' THEN 1
    WHEN 'high' THEN 2
    WHEN 'medium' THEN 3
    WHEN 'low' THEN 4
  END,
  r.created_at ASC;

-- Recent moderation actions
CREATE VIEW IF NOT EXISTS recent_mod_actions AS
SELECT 
  ma.*,
  u1.username_original as target_username,
  u2.username_original as moderator_username
FROM moderation_actions ma
LEFT JOIN users u1 ON ma.user_id = u1.id
LEFT JOIN users u2 ON ma.moderator_id = u2.id
ORDER BY ma.created_at DESC
LIMIT 100;
