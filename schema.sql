/**
 * QTI Auth System - Database Schema
 * Cloudflare D1 (SQLite)
 *
 * This schema defines the complete data model for user authentication,
 * session management, content moderation, and game statistics tracking.
 */

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username_original TEXT UNIQUE,
  username_canonical TEXT UNIQUE,
  email TEXT,
  email_normalized TEXT,
  oauth_provider TEXT,
  oauth_id TEXT,
  role TEXT DEFAULT 'user',
  date_of_birth TEXT NOT NULL,
  is_child INTEGER NOT NULL DEFAULT 0,
  age_verified_at INTEGER NOT NULL,
  age_verification_method TEXT NOT NULL,
  parental_consent INTEGER DEFAULT 0,
  tos_accepted_at INTEGER,
  tos_version TEXT,
  is_banned INTEGER DEFAULT 0,
  ban_reason TEXT,
  banned_at INTEGER,
  banned_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(oauth_provider, oauth_id)
);

CREATE INDEX IF NOT EXISTS idx_users_email_normalized ON users(email_normalized);
CREATE INDEX IF NOT EXISTS idx_users_username_canonical ON users(username_canonical);
CREATE INDEX IF NOT EXISTS idx_users_oauth ON users(oauth_provider, oauth_id);
CREATE INDEX IF NOT EXISTS idx_users_is_child ON users(is_child);
CREATE INDEX IF NOT EXISTS idx_users_is_banned ON users(is_banned);

CREATE TABLE IF NOT EXISTS username_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  old_username TEXT,
  new_username TEXT NOT NULL,
  changed_at INTEGER NOT NULL,
  changed_reason TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_username_history_user ON username_history(user_id);
CREATE INDEX IF NOT EXISTS idx_username_history_changed_at ON username_history(changed_at);

CREATE TABLE IF NOT EXISTS username_cooldowns (
  user_id TEXT PRIMARY KEY,
  last_change_at INTEGER NOT NULL,
  change_count_this_year INTEGER DEFAULT 1,
  year INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS user_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  ip_address TEXT NOT NULL,
  ip_subnet TEXT NOT NULL,
  ip_country TEXT,
  user_agent TEXT,
  user_agent_hash TEXT,
  browser_fingerprint TEXT,
  tls_fingerprint TEXT,
  timezone TEXT,
  screen_resolution TEXT,
  language TEXT,
  auth_method TEXT NOT NULL,
  device_type TEXT,
  trust_level TEXT DEFAULT 'full',
  flagged_at INTEGER,
  flag_reason TEXT,
  created_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_token_hash ON user_sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_user_sessions_expires ON user_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_user_sessions_ip ON user_sessions(ip_address);
CREATE INDEX IF NOT EXISTS idx_user_sessions_trust ON user_sessions(trust_level);
CREATE INDEX IF NOT EXISTS idx_user_sessions_revoked ON user_sessions(revoked_at);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user_active ON user_sessions(user_id, revoked_at, expires_at);

CREATE TABLE IF NOT EXISTS session_security_events (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  user_id TEXT,
  event_type TEXT NOT NULL,
  ip_address TEXT,
  ip_country TEXT,
  details TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES user_sessions(id) ON DELETE SET NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_session_events_user ON session_security_events(user_id);
CREATE INDEX IF NOT EXISTS idx_session_events_session ON session_security_events(session_id);
CREATE INDEX IF NOT EXISTS idx_session_events_type ON session_security_events(event_type);
CREATE INDEX IF NOT EXISTS idx_session_events_created ON session_security_events(created_at);

CREATE TABLE IF NOT EXISTS email_tokens (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  email_normalized TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  date_of_birth TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_email_tokens_hash ON email_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_email_tokens_expires ON email_tokens(expires_at);

CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oauth_states_created ON oauth_states(created_at);

CREATE TABLE IF NOT EXISTS oauth_temp (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  oauth_id TEXT NOT NULL,
  email TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oauth_temp_created ON oauth_temp(created_at);

CREATE TABLE IF NOT EXISTS mail_rate_limits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,
  timestamp INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mail_rate_limits_key ON mail_rate_limits(key);
CREATE INDEX IF NOT EXISTS idx_mail_rate_limits_timestamp ON mail_rate_limits(timestamp);

CREATE TABLE IF NOT EXISTS user_reports (
  id TEXT PRIMARY KEY,
  reporter_user_id TEXT,
  reported_user_id TEXT,
  reported_content_id TEXT,
  content_type TEXT,
  report_type TEXT NOT NULL,
  report_subtype TEXT,
  description TEXT,
  status TEXT DEFAULT 'pending',
  priority TEXT DEFAULT 'medium',
  reviewed_at INTEGER,
  reviewed_by TEXT,
  review_notes TEXT,
  content_snapshot TEXT,
  metadata TEXT,
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

CREATE TABLE IF NOT EXISTS moderation_actions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  moderator_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  duration INTEGER,
  reason TEXT NOT NULL,
  related_report_id TEXT,
  internal_notes TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (moderator_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (related_report_id) REFERENCES user_reports(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_mod_actions_user ON moderation_actions(user_id);
CREATE INDEX IF NOT EXISTS idx_mod_actions_moderator ON moderation_actions(moderator_id);
CREATE INDEX IF NOT EXISTS idx_mod_actions_created ON moderation_actions(created_at);
CREATE INDEX IF NOT EXISTS idx_mod_actions_type ON moderation_actions(action_type);

CREATE TABLE IF NOT EXISTS content_flags (
  id TEXT PRIMARY KEY,
  content_id TEXT NOT NULL,
  content_type TEXT NOT NULL,
  user_id TEXT,
  flagged_by TEXT NOT NULL,
  flag_reason TEXT NOT NULL,
  severity TEXT DEFAULT 'medium',
  status TEXT DEFAULT 'pending',
  automated_score REAL,
  content_hash TEXT,
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

CREATE TABLE IF NOT EXISTS banned_words (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  word TEXT NOT NULL UNIQUE,
  severity TEXT DEFAULT 'medium',
  category TEXT,
  case_sensitive INTEGER DEFAULT 0,
  is_regex INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_banned_words_word ON banned_words(word);
CREATE INDEX IF NOT EXISTS idx_banned_words_severity ON banned_words(severity);

CREATE TABLE IF NOT EXISTS rate_limits (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  count INTEGER DEFAULT 1,
  window_start INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_expires ON rate_limits(expires_at);

CREATE TABLE IF NOT EXISTS admin_logs (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_id TEXT,
  target_type TEXT,
  details TEXT,
  ip_address TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (admin_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_logs_admin ON admin_logs(admin_id);
CREATE INDEX IF NOT EXISTS idx_admin_logs_created ON admin_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_admin_logs_action ON admin_logs(action);

CREATE TABLE IF NOT EXISTS daily_stats (
  date TEXT PRIMARY KEY,
  new_users INTEGER DEFAULT 0,
  child_users_created INTEGER DEFAULT 0,
  reports_submitted INTEGER DEFAULT 0,
  reports_actioned INTEGER DEFAULT 0,
  accounts_banned INTEGER DEFAULT 0,
  content_removed INTEGER DEFAULT 0,
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO banned_words (word, severity, category, created_at) VALUES
('nigger', 'high', 'slur', unixepoch()),
('faggot', 'high', 'slur', unixepoch()),
('tranny', 'high', 'slur', unixepoch()),
('kike', 'high', 'slur', unixepoch()),
('chink', 'high', 'slur', unixepoch()),
('kill yourself', 'high', 'threat', unixepoch()),
('kys', 'high', 'threat', unixepoch()),
('die', 'medium', 'threat', unixepoch()),
('suicide', 'high', 'self_harm', unixepoch()),
('cut myself', 'high', 'self_harm', unixepoch()),
('fuck', 'medium', 'profanity', unixepoch()),
('shit', 'medium', 'profanity', unixepoch()),
('cunt', 'high', 'profanity', unixepoch()),
('bitch', 'medium', 'profanity', unixepoch()),
('free robux', 'medium', 'scam', unixepoch()),
('click here', 'low', 'spam', unixepoch()),
('dm me', 'low', 'spam', unixepoch());

CREATE VIEW IF NOT EXISTS active_child_users AS
SELECT id, username_original, date_of_birth, age_verification_method, created_at
FROM users
WHERE is_child = 1 AND is_banned = 0;

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
