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
