-- setup.sql: canonical full bootstrap schema generated from schema.sql + migrations
-- Generated: 2026-02-14 00:22:29

/**
 * QTI Auth System - Database Schema
 * Cloudflare D1 (SQLite)
 *
 * This schema defines the complete data model for user authentication,
 * session management, content moderation, and game statistics tracking.
 */
CREATE TABLE
  IF NOT EXISTS users (
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
    UNIQUE (oauth_provider, oauth_id)
  );

CREATE INDEX IF NOT EXISTS idx_users_email_normalized ON users (email_normalized);

CREATE INDEX IF NOT EXISTS idx_users_username_canonical ON users (username_canonical);

CREATE INDEX IF NOT EXISTS idx_users_oauth ON users (oauth_provider, oauth_id);

CREATE INDEX IF NOT EXISTS idx_users_is_child ON users (is_child);

CREATE INDEX IF NOT EXISTS idx_users_is_banned ON users (is_banned);

CREATE TABLE
  IF NOT EXISTS username_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    old_username TEXT,
    new_username TEXT NOT NULL,
    changed_at INTEGER NOT NULL,
    changed_reason TEXT,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
  );

CREATE INDEX IF NOT EXISTS idx_username_history_user ON username_history (user_id);

CREATE INDEX IF NOT EXISTS idx_username_history_changed_at ON username_history (changed_at);

CREATE TABLE
  IF NOT EXISTS username_cooldowns (
    user_id TEXT PRIMARY KEY,
    last_change_at INTEGER NOT NULL,
    change_count_this_year INTEGER DEFAULT 1,
    year INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
  );

CREATE TABLE
  IF NOT EXISTS user_sessions (
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
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
  );

CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions (user_id);

CREATE INDEX IF NOT EXISTS idx_user_sessions_token_hash ON user_sessions (token_hash);

CREATE INDEX IF NOT EXISTS idx_user_sessions_expires ON user_sessions (expires_at);

CREATE INDEX IF NOT EXISTS idx_user_sessions_ip ON user_sessions (ip_address);

CREATE INDEX IF NOT EXISTS idx_user_sessions_trust ON user_sessions (trust_level);

CREATE INDEX IF NOT EXISTS idx_user_sessions_revoked ON user_sessions (revoked_at);

CREATE INDEX IF NOT EXISTS idx_user_sessions_user_active ON user_sessions (user_id, revoked_at, expires_at);

CREATE TABLE
  IF NOT EXISTS session_security_events (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    user_id TEXT,
    event_type TEXT NOT NULL,
    ip_address TEXT,
    ip_country TEXT,
    details TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (session_id) REFERENCES user_sessions (id) ON DELETE SET NULL,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL
  );

CREATE INDEX IF NOT EXISTS idx_session_events_user ON session_security_events (user_id);

CREATE INDEX IF NOT EXISTS idx_session_events_session ON session_security_events (session_id);

CREATE INDEX IF NOT EXISTS idx_session_events_type ON session_security_events (event_type);

CREATE INDEX IF NOT EXISTS idx_session_events_created ON session_security_events (created_at);

CREATE TABLE
  IF NOT EXISTS email_tokens (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    email_normalized TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    date_of_birth TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL
  );

CREATE INDEX IF NOT EXISTS idx_email_tokens_hash ON email_tokens (token_hash);

CREATE INDEX IF NOT EXISTS idx_email_tokens_expires ON email_tokens (expires_at);

CREATE TABLE
  IF NOT EXISTS oauth_states (
    state TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

CREATE INDEX IF NOT EXISTS idx_oauth_states_created ON oauth_states (created_at);

CREATE TABLE
  IF NOT EXISTS oauth_temp (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    oauth_id TEXT NOT NULL,
    email TEXT,
    created_at INTEGER NOT NULL
  );

CREATE INDEX IF NOT EXISTS idx_oauth_temp_created ON oauth_temp (created_at);

CREATE TABLE
  IF NOT EXISTS mail_rate_limits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL,
    timestamp INTEGER NOT NULL
  );

CREATE INDEX IF NOT EXISTS idx_mail_rate_limits_key ON mail_rate_limits (key);

CREATE INDEX IF NOT EXISTS idx_mail_rate_limits_timestamp ON mail_rate_limits (timestamp);

CREATE TABLE
  IF NOT EXISTS user_reports (
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
    FOREIGN KEY (reported_user_id) REFERENCES users (id) ON DELETE SET NULL,
    FOREIGN KEY (reviewed_by) REFERENCES users (id) ON DELETE SET NULL
  );

CREATE INDEX IF NOT EXISTS idx_reports_status ON user_reports (status);

CREATE INDEX IF NOT EXISTS idx_reports_reported_user ON user_reports (reported_user_id);

CREATE INDEX IF NOT EXISTS idx_reports_reporter ON user_reports (reporter_user_id);

CREATE INDEX IF NOT EXISTS idx_reports_created ON user_reports (created_at);

CREATE INDEX IF NOT EXISTS idx_reports_priority ON user_reports (priority);

CREATE TABLE
  IF NOT EXISTS moderation_actions (
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
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    FOREIGN KEY (moderator_id) REFERENCES users (id) ON DELETE SET NULL,
    FOREIGN KEY (related_report_id) REFERENCES user_reports (id) ON DELETE SET NULL
  );

CREATE INDEX IF NOT EXISTS idx_mod_actions_user ON moderation_actions (user_id);

CREATE INDEX IF NOT EXISTS idx_mod_actions_moderator ON moderation_actions (moderator_id);

CREATE INDEX IF NOT EXISTS idx_mod_actions_created ON moderation_actions (created_at);

CREATE INDEX IF NOT EXISTS idx_mod_actions_type ON moderation_actions (action_type);

CREATE TABLE
  IF NOT EXISTS content_flags (
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
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL,
    FOREIGN KEY (reviewed_by) REFERENCES users (id) ON DELETE SET NULL
  );

CREATE INDEX IF NOT EXISTS idx_content_flags_status ON content_flags (status);

CREATE INDEX IF NOT EXISTS idx_content_flags_user ON content_flags (user_id);

CREATE INDEX IF NOT EXISTS idx_content_flags_created ON content_flags (created_at);

CREATE INDEX IF NOT EXISTS idx_content_flags_severity ON content_flags (severity);

CREATE TABLE
  IF NOT EXISTS banned_words (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    word TEXT NOT NULL UNIQUE,
    severity TEXT DEFAULT 'medium',
    category TEXT,
    case_sensitive INTEGER DEFAULT 0,
    is_regex INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL
  );

CREATE INDEX IF NOT EXISTS idx_banned_words_word ON banned_words (word);

CREATE INDEX IF NOT EXISTS idx_banned_words_severity ON banned_words (severity);

CREATE TABLE
  IF NOT EXISTS rate_limits (
    id TEXT PRIMARY KEY,
    action TEXT NOT NULL,
    count INTEGER DEFAULT 1,
    window_start INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

CREATE INDEX IF NOT EXISTS idx_rate_limits_expires ON rate_limits (expires_at);

CREATE TABLE
  IF NOT EXISTS admin_logs (
    id TEXT PRIMARY KEY,
    admin_id TEXT NOT NULL,
    action TEXT NOT NULL,
    target_id TEXT,
    target_type TEXT,
    details TEXT,
    ip_address TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (admin_id) REFERENCES users (id) ON DELETE SET NULL
  );

CREATE INDEX IF NOT EXISTS idx_admin_logs_admin ON admin_logs (admin_id);

CREATE INDEX IF NOT EXISTS idx_admin_logs_created ON admin_logs (created_at);

CREATE INDEX IF NOT EXISTS idx_admin_logs_action ON admin_logs (action);

CREATE TABLE
  IF NOT EXISTS daily_stats (
    date TEXT PRIMARY KEY,
    new_users INTEGER DEFAULT 0,
    child_users_created INTEGER DEFAULT 0,
    reports_submitted INTEGER DEFAULT 0,
    reports_actioned INTEGER DEFAULT 0,
    accounts_banned INTEGER DEFAULT 0,
    content_removed INTEGER DEFAULT 0,
    updated_at INTEGER NOT NULL
  );

INSERT
OR IGNORE INTO banned_words (word, severity, category, created_at)
VALUES
  ('nigger', 'high', 'slur', unixepoch ()),
  ('faggot', 'high', 'slur', unixepoch ()),
  ('tranny', 'high', 'slur', unixepoch ()),
  ('kike', 'high', 'slur', unixepoch ()),
  ('chink', 'high', 'slur', unixepoch ()),
  ('kill yourself', 'high', 'threat', unixepoch ()),
  ('kys', 'high', 'threat', unixepoch ()),
  ('die', 'medium', 'threat', unixepoch ()),
  ('suicide', 'high', 'self_harm', unixepoch ()),
  ('cut myself', 'high', 'self_harm', unixepoch ()),
  ('fuck', 'medium', 'profanity', unixepoch ()),
  ('shit', 'medium', 'profanity', unixepoch ()),
  ('cunt', 'high', 'profanity', unixepoch ()),
  ('bitch', 'medium', 'profanity', unixepoch ()),
  ('free robux', 'medium', 'scam', unixepoch ()),
  ('click here', 'low', 'spam', unixepoch ()),
  ('dm me', 'low', 'spam', unixepoch ());

CREATE VIEW
  IF NOT EXISTS active_child_users AS
SELECT
  id,
  username_original,
  date_of_birth,
  age_verification_method,
  created_at
FROM
  users
WHERE
  is_child = 1
  AND is_banned = 0;

CREATE VIEW
  IF NOT EXISTS pending_reports AS
SELECT
  r.*,
  u1.username_original as reporter_username,
  u2.username_original as reported_username
FROM
  user_reports r
  LEFT JOIN users u1 ON r.reporter_user_id = u1.id
  LEFT JOIN users u2 ON r.reported_user_id = u2.id
WHERE
  r.status = 'pending'
ORDER BY
  CASE r.priority
    WHEN 'urgent' THEN 1
    WHEN 'high' THEN 2
    WHEN 'medium' THEN 3
    WHEN 'low' THEN 4
  END,
  r.created_at ASC;

CREATE VIEW
  IF NOT EXISTS recent_mod_actions AS
SELECT
  ma.*,
  u1.username_original as target_username,
  u2.username_original as moderator_username
FROM
  moderation_actions ma
  LEFT JOIN users u1 ON ma.user_id = u1.id
  LEFT JOIN users u2 ON ma.moderator_id = u2.id
ORDER BY
  ma.created_at DESC
LIMIT
  100;

CREATE TABLE
  IF NOT EXISTS oauth_clients (
    id TEXT PRIMARY KEY,
    client_secret_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    logo_url TEXT,
    homepage_url TEXT,
    privacy_policy_url TEXT,
    redirect_uris TEXT NOT NULL, -- JSON array of allowed redirect URIs
    allowed_scopes TEXT NOT NULL DEFAULT '["openid","profile","email"]', -- JSON array
    client_type TEXT NOT NULL DEFAULT 'confidential', -- 'confidential' or 'public'
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    is_approved INTEGER NOT NULL DEFAULT 0, -- Admin must approve for public use
    FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE CASCADE
  );

CREATE INDEX IF NOT EXISTS idx_oauth_clients_created_by ON oauth_clients (created_by);

CREATE INDEX IF NOT EXISTS idx_oauth_clients_is_approved ON oauth_clients (is_approved);

CREATE INDEX IF NOT EXISTS idx_oauth_clients_is_active ON oauth_clients (is_active);

CREATE TABLE
  IF NOT EXISTS oauth_authorization_codes (
    code_hash TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    scope TEXT NOT NULL,
    code_challenge TEXT, -- PKCE challenge
    code_challenge_method TEXT, -- S256 only (plain not allowed in OAuth 2.1)
    nonce TEXT, -- OIDC nonce for ID token
    auth_time INTEGER NOT NULL, -- When user authenticated
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (client_id) REFERENCES oauth_clients (id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
  );

CREATE INDEX IF NOT EXISTS idx_oauth_codes_client ON oauth_authorization_codes (client_id);

CREATE INDEX IF NOT EXISTS idx_oauth_codes_user ON oauth_authorization_codes (user_id);

CREATE INDEX IF NOT EXISTS idx_oauth_codes_expires ON oauth_authorization_codes (expires_at);

CREATE TABLE
  IF NOT EXISTS oauth_access_tokens (
    token_hash TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    scope TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (client_id) REFERENCES oauth_clients (id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
  );

CREATE INDEX IF NOT EXISTS idx_oauth_access_client ON oauth_access_tokens (client_id);

CREATE INDEX IF NOT EXISTS idx_oauth_access_user ON oauth_access_tokens (user_id);

CREATE INDEX IF NOT EXISTS idx_oauth_access_expires ON oauth_access_tokens (expires_at);

CREATE TABLE
  IF NOT EXISTS oauth_refresh_tokens (
    token_hash TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    scope TEXT NOT NULL,
    access_token_hash TEXT, -- Associated access token
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (client_id) REFERENCES oauth_clients (id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
  );

CREATE INDEX IF NOT EXISTS idx_oauth_refresh_client ON oauth_refresh_tokens (client_id);

CREATE INDEX IF NOT EXISTS idx_oauth_refresh_user ON oauth_refresh_tokens (user_id);

CREATE INDEX IF NOT EXISTS idx_oauth_refresh_expires ON oauth_refresh_tokens (expires_at);

CREATE TABLE
  IF NOT EXISTS oauth_consents (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    scope TEXT NOT NULL, -- JSON array of granted scopes
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (user_id, client_id),
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    FOREIGN KEY (client_id) REFERENCES oauth_clients (id) ON DELETE CASCADE
  );

CREATE INDEX IF NOT EXISTS idx_oauth_consents_user ON oauth_consents (user_id);

CREATE INDEX IF NOT EXISTS idx_oauth_consents_client ON oauth_consents (client_id);

CREATE TABLE
  IF NOT EXISTS kb_articles (
    id TEXT PRIMARY KEY,
    slug TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    category TEXT NOT NULL,
    tags TEXT,
    author_id TEXT NOT NULL,
    is_published INTEGER DEFAULT 0,
    view_count INTEGER DEFAULT 0,
    helpful_yes INTEGER DEFAULT 0,
    helpful_no INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    published_at INTEGER,
    FOREIGN KEY (author_id) REFERENCES users (id) ON DELETE SET NULL
  );

CREATE INDEX IF NOT EXISTS idx_kb_articles_slug ON kb_articles (slug);

CREATE INDEX IF NOT EXISTS idx_kb_articles_category ON kb_articles (category);

CREATE INDEX IF NOT EXISTS idx_kb_articles_published ON kb_articles (is_published);

CREATE INDEX IF NOT EXISTS idx_kb_articles_created ON kb_articles (created_at);

CREATE TABLE
  IF NOT EXISTS support_tickets (
    id TEXT PRIMARY KEY,
    ticket_number INTEGER UNIQUE NOT NULL,
    user_id TEXT NOT NULL,
    subject TEXT NOT NULL,
    category TEXT NOT NULL,
    priority TEXT DEFAULT 'normal',
    status TEXT DEFAULT 'open',
    assigned_to TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    resolved_at INTEGER,
    closed_at INTEGER,
    satisfaction_rating INTEGER,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    FOREIGN KEY (assigned_to) REFERENCES users (id) ON DELETE SET NULL
  );

CREATE INDEX IF NOT EXISTS idx_tickets_user ON support_tickets (user_id);

CREATE INDEX IF NOT EXISTS idx_tickets_status ON support_tickets (status);

CREATE INDEX IF NOT EXISTS idx_tickets_assigned ON support_tickets (assigned_to);

CREATE INDEX IF NOT EXISTS idx_tickets_created ON support_tickets (created_at);

CREATE INDEX IF NOT EXISTS idx_tickets_priority ON support_tickets (priority);

CREATE INDEX IF NOT EXISTS idx_tickets_number ON support_tickets (ticket_number);

CREATE TABLE
  IF NOT EXISTS ticket_messages (
    id TEXT PRIMARY KEY,
    ticket_id TEXT NOT NULL,
    author_id TEXT NOT NULL,
    content TEXT NOT NULL,
    is_staff_reply INTEGER DEFAULT 0,
    is_internal_note INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    edited_at INTEGER,
    FOREIGN KEY (ticket_id) REFERENCES support_tickets (id) ON DELETE CASCADE,
    FOREIGN KEY (author_id) REFERENCES users (id) ON DELETE SET NULL
  );

CREATE INDEX IF NOT EXISTS idx_messages_ticket ON ticket_messages (ticket_id);

CREATE INDEX IF NOT EXISTS idx_messages_author ON ticket_messages (author_id);

CREATE INDEX IF NOT EXISTS idx_messages_created ON ticket_messages (created_at);

CREATE TABLE
  IF NOT EXISTS kb_categories (
    id TEXT PRIMARY KEY,
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    icon TEXT,
    display_order INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_at INTEGER NOT NULL
  );

CREATE TABLE
  IF NOT EXISTS ticket_sequence (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    next_number INTEGER NOT NULL DEFAULT 1
  );

INSERT
OR IGNORE INTO ticket_sequence (id, next_number)
VALUES
  (1, 1);

-- ============================================================
-- Migration: 0002_games_and_achievements.sql
-- ============================================================
-- Migration: Games and Achievements System
-- Run with: wrangler d1 migrations apply qti_auth --remote

-- Games table
CREATE TABLE IF NOT EXISTS games (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  description TEXT,
  icon_url TEXT,
  is_active INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Game achievements table
CREATE TABLE IF NOT EXISTS game_achievements (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  icon_url TEXT,
  points INTEGER DEFAULT 10,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
);

-- User achievements (unlocked achievements)
CREATE TABLE IF NOT EXISTS user_achievements (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  achievement_id TEXT NOT NULL,
  unlocked_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (achievement_id) REFERENCES game_achievements(id) ON DELETE CASCADE,
  UNIQUE(user_id, achievement_id)
);

-- User game stats (custom stats per game)
CREATE TABLE IF NOT EXISTS user_game_stats (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  game_id TEXT NOT NULL,
  stats_data TEXT, -- JSON blob for flexible stats
  last_played INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
  UNIQUE(user_id, game_id)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_games_slug ON games(slug);
CREATE INDEX IF NOT EXISTS idx_games_active ON games(is_active);
CREATE INDEX IF NOT EXISTS idx_game_achievements_game ON game_achievements(game_id);
CREATE INDEX IF NOT EXISTS idx_user_achievements_user ON user_achievements(user_id);
CREATE INDEX IF NOT EXISTS idx_user_achievements_achievement ON user_achievements(achievement_id);
CREATE INDEX IF NOT EXISTS idx_user_game_stats_user ON user_game_stats(user_id);
CREATE INDEX IF NOT EXISTS idx_user_game_stats_game ON user_game_stats(game_id);

-- ============================================================
-- Migration: 0003_add_admin_only_to_games.sql
-- ============================================================
-- Migration: Add admin_only flag to games table
-- This allows marking games that should only be visible to admins

-- Add admin_only column to games table (defaults to 0 for normal games)
ALTER TABLE games ADD COLUMN admin_only INTEGER DEFAULT 0;

-- Mark the test game as admin-only
UPDATE games SET admin_only = 1 WHERE slug = 'test-game';

-- ============================================================
-- Migration: 0004_jagsmp_minecraft_linking.sql
-- ============================================================
-- Migration: JagSMP Minecraft Account Linking
-- Description: Tables for linking Minecraft accounts to QTI accounts
-- Date: 2026-01-10

-- Table: minecraft_accounts
-- Stores linked Minecraft accounts with player UUIDs and usernames
CREATE TABLE IF NOT EXISTS minecraft_accounts (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    user_id TEXT NOT NULL,
    minecraft_uuid TEXT NOT NULL UNIQUE,
    minecraft_username TEXT NOT NULL,
    linked_at INTEGER NOT NULL DEFAULT (unixepoch()),
    last_updated INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_minecraft_accounts_user_id ON minecraft_accounts(user_id);
CREATE INDEX idx_minecraft_accounts_minecraft_uuid ON minecraft_accounts(minecraft_uuid);

-- Table: minecraft_link_codes
-- Temporary codes generated by /qtilink command for account verification
CREATE TABLE IF NOT EXISTS minecraft_link_codes (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    code TEXT NOT NULL UNIQUE,
    minecraft_uuid TEXT NOT NULL,
    minecraft_username TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    expires_at INTEGER NOT NULL,
    used INTEGER DEFAULT 0,
    used_by_user_id TEXT,
    used_at INTEGER,
    FOREIGN KEY (used_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX idx_minecraft_link_codes_code ON minecraft_link_codes(code);
CREATE INDEX idx_minecraft_link_codes_expires ON minecraft_link_codes(expires_at);
CREATE INDEX idx_minecraft_link_codes_minecraft_uuid ON minecraft_link_codes(minecraft_uuid);

-- Table: minecraft_unlink_cooldowns
-- Tracks unlinking cooldowns to prevent abuse (7-day cooldown)
CREATE TABLE IF NOT EXISTS minecraft_unlink_cooldowns (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    user_id TEXT NOT NULL,
    unlinked_at INTEGER NOT NULL DEFAULT (unixepoch()),
    can_link_again_at INTEGER NOT NULL,
    previous_minecraft_uuid TEXT,
    previous_minecraft_username TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_minecraft_unlink_cooldowns_user_id ON minecraft_unlink_cooldowns(user_id);
CREATE INDEX idx_minecraft_unlink_cooldowns_can_link_again ON minecraft_unlink_cooldowns(can_link_again_at);

-- Table: minecraft_player_stats
-- Stores player statistics from the Minecraft server
CREATE TABLE IF NOT EXISTS minecraft_player_stats (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    minecraft_uuid TEXT NOT NULL UNIQUE,

    -- Playtime & Activity Stats
    total_playtime_minutes INTEGER DEFAULT 0,
    first_joined INTEGER,
    last_seen INTEGER,
    total_sessions INTEGER DEFAULT 0,

    -- PvP & Combat Stats
    player_kills INTEGER DEFAULT 0,
    deaths INTEGER DEFAULT 0,
    mob_kills INTEGER DEFAULT 0,
    damage_dealt REAL DEFAULT 0.0,
    damage_taken REAL DEFAULT 0.0,

    -- Additional stats as JSON for flexibility
    stats_json TEXT DEFAULT '{}',

    -- Metadata
    last_updated INTEGER NOT NULL DEFAULT (unixepoch()),

    FOREIGN KEY (minecraft_uuid) REFERENCES minecraft_accounts(minecraft_uuid) ON DELETE CASCADE
);

CREATE INDEX idx_minecraft_player_stats_minecraft_uuid ON minecraft_player_stats(minecraft_uuid);
CREATE INDEX idx_minecraft_player_stats_last_updated ON minecraft_player_stats(last_updated);

-- Table: minecraft_achievements
-- Server-specific achievements for JagSMP
CREATE TABLE IF NOT EXISTS minecraft_achievements (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    achievement_key TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT,
    icon_url TEXT,
    points INTEGER DEFAULT 0,
    category TEXT DEFAULT 'general',
    is_secret INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_minecraft_achievements_category ON minecraft_achievements(category);

-- Table: minecraft_player_achievements
-- Tracks which achievements players have unlocked
CREATE TABLE IF NOT EXISTS minecraft_player_achievements (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    minecraft_uuid TEXT NOT NULL,
    achievement_id TEXT NOT NULL,
    unlocked_at INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (minecraft_uuid) REFERENCES minecraft_accounts(minecraft_uuid) ON DELETE CASCADE,
    FOREIGN KEY (achievement_id) REFERENCES minecraft_achievements(id) ON DELETE CASCADE,
    UNIQUE(minecraft_uuid, achievement_id)
);

CREATE INDEX idx_minecraft_player_achievements_minecraft_uuid ON minecraft_player_achievements(minecraft_uuid);
CREATE INDEX idx_minecraft_player_achievements_achievement_id ON minecraft_player_achievements(achievement_id);

-- Table: minecraft_activity_log
-- Recent activity feed for players
CREATE TABLE IF NOT EXISTS minecraft_activity_log (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    minecraft_uuid TEXT NOT NULL,
    activity_type TEXT NOT NULL, -- 'login', 'logout', 'achievement', 'death', 'kill', etc.
    activity_data TEXT DEFAULT '{}', -- JSON with additional context
    occurred_at INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (minecraft_uuid) REFERENCES minecraft_accounts(minecraft_uuid) ON DELETE CASCADE
);

CREATE INDEX idx_minecraft_activity_log_minecraft_uuid ON minecraft_activity_log(minecraft_uuid);
CREATE INDEX idx_minecraft_activity_log_occurred_at ON minecraft_activity_log(occurred_at);

-- Insert some default achievements
INSERT INTO minecraft_achievements (achievement_key, name, description, category, points) VALUES
('first_join', 'Welcome to JagSMP!', 'Join the server for the first time', 'milestone', 10),
('playtime_1h', 'Getting Started', 'Play for 1 hour', 'playtime', 15),
('playtime_10h', 'Regular Player', 'Play for 10 hours', 'playtime', 25),
('playtime_50h', 'Dedicated Member', 'Play for 50 hours', 'playtime', 50),
('playtime_100h', 'Server Veteran', 'Play for 100 hours', 'playtime', 100),
('first_kill', 'First Blood', 'Get your first player kill', 'pvp', 15),
('kill_streak_5', 'On Fire!', 'Get 5 kills without dying', 'pvp', 30),
('deaths_0', 'Untouchable', 'Play for 5 hours without dying', 'pvp', 50),
('kdr_2', 'Warrior', 'Achieve a 2.0 K/D ratio with at least 50 kills', 'pvp', 40);

-- ============================================================
-- Migration: 0005_jagsmp_comprehensive_stats.sql
-- ============================================================
-- Migration: JagSMP Comprehensive Stats Expansion
-- Description: Adds detailed combat, movement, interaction, building, and misc stats
-- Date: 2026-01-11

-- Add comprehensive combat stats columns to minecraft_player_stats
ALTER TABLE minecraft_player_stats ADD COLUMN damage_blocked_by_shield REAL DEFAULT 0.0;
ALTER TABLE minecraft_player_stats ADD COLUMN damage_resisted REAL DEFAULT 0.0;
ALTER TABLE minecraft_player_stats ADD COLUMN damage_absorbed REAL DEFAULT 0.0;

-- Add movement stats columns (in meters)
ALTER TABLE minecraft_player_stats ADD COLUMN distance_walked REAL DEFAULT 0.0;
ALTER TABLE minecraft_player_stats ADD COLUMN distance_sprinted REAL DEFAULT 0.0;
ALTER TABLE minecraft_player_stats ADD COLUMN distance_crouched REAL DEFAULT 0.0;
ALTER TABLE minecraft_player_stats ADD COLUMN distance_flown REAL DEFAULT 0.0;
ALTER TABLE minecraft_player_stats ADD COLUMN distance_climbed REAL DEFAULT 0.0;
ALTER TABLE minecraft_player_stats ADD COLUMN distance_fallen REAL DEFAULT 0.0;
ALTER TABLE minecraft_player_stats ADD COLUMN distance_swam REAL DEFAULT 0.0;
ALTER TABLE minecraft_player_stats ADD COLUMN distance_minecart REAL DEFAULT 0.0;
ALTER TABLE minecraft_player_stats ADD COLUMN distance_boat REAL DEFAULT 0.0;
ALTER TABLE minecraft_player_stats ADD COLUMN distance_pig REAL DEFAULT 0.0;
ALTER TABLE minecraft_player_stats ADD COLUMN distance_horse REAL DEFAULT 0.0;
ALTER TABLE minecraft_player_stats ADD COLUMN distance_elytra REAL DEFAULT 0.0;
ALTER TABLE minecraft_player_stats ADD COLUMN jumps INTEGER DEFAULT 0;

-- Add interaction stats columns
ALTER TABLE minecraft_player_stats ADD COLUMN times_slept INTEGER DEFAULT 0;
ALTER TABLE minecraft_player_stats ADD COLUMN barrels_opened INTEGER DEFAULT 0;
ALTER TABLE minecraft_player_stats ADD COLUMN ender_chests_opened INTEGER DEFAULT 0;
ALTER TABLE minecraft_player_stats ADD COLUMN items_enchanted INTEGER DEFAULT 0;
ALTER TABLE minecraft_player_stats ADD COLUMN animals_bred INTEGER DEFAULT 0;
ALTER TABLE minecraft_player_stats ADD COLUMN fish_caught INTEGER DEFAULT 0;
ALTER TABLE minecraft_player_stats ADD COLUMN traded_with_villager INTEGER DEFAULT 0;
ALTER TABLE minecraft_player_stats ADD COLUMN talked_to_villager INTEGER DEFAULT 0;
ALTER TABLE minecraft_player_stats ADD COLUMN cake_slices_eaten INTEGER DEFAULT 0;
ALTER TABLE minecraft_player_stats ADD COLUMN bells_rung INTEGER DEFAULT 0;

-- Add building/crafting stats columns
ALTER TABLE minecraft_player_stats ADD COLUMN items_crafted INTEGER DEFAULT 0;
ALTER TABLE minecraft_player_stats ADD COLUMN beacons_interacted INTEGER DEFAULT 0;
ALTER TABLE minecraft_player_stats ADD COLUMN anvils_used INTEGER DEFAULT 0;
ALTER TABLE minecraft_player_stats ADD COLUMN lecterns_interacted INTEGER DEFAULT 0;
ALTER TABLE minecraft_player_stats ADD COLUMN grindstones_interacted INTEGER DEFAULT 0;
ALTER TABLE minecraft_player_stats ADD COLUMN looms_interacted INTEGER DEFAULT 0;
ALTER TABLE minecraft_player_stats ADD COLUMN smithing_tables_interacted INTEGER DEFAULT 0;
ALTER TABLE minecraft_player_stats ADD COLUMN stonecutters_interacted INTEGER DEFAULT 0;

-- Add misc stats columns
ALTER TABLE minecraft_player_stats ADD COLUMN raids_triggered INTEGER DEFAULT 0;
ALTER TABLE minecraft_player_stats ADD COLUMN raids_won INTEGER DEFAULT 0;
ALTER TABLE minecraft_player_stats ADD COLUMN targets_hit INTEGER DEFAULT 0;
ALTER TABLE minecraft_player_stats ADD COLUMN time_since_rest INTEGER DEFAULT 0;
ALTER TABLE minecraft_player_stats ADD COLUMN time_since_death INTEGER DEFAULT 0;
ALTER TABLE minecraft_player_stats ADD COLUMN flower_potted INTEGER DEFAULT 0;
ALTER TABLE minecraft_player_stats ADD COLUMN armor_pieces_cleaned INTEGER DEFAULT 0;
ALTER TABLE minecraft_player_stats ADD COLUMN banners_cleaned INTEGER DEFAULT 0;

-- Add current session info columns
ALTER TABLE minecraft_player_stats ADD COLUMN session_duration_seconds INTEGER DEFAULT 0;
ALTER TABLE minecraft_player_stats ADD COLUMN login_timestamp INTEGER DEFAULT 0;

-- ============================================================
-- Migration: 0006_account_locking.sql
-- ============================================================
-- Migration: Add account locking support
-- This adds temporary lock functionality separate from permanent bans

-- Add locking fields to users table
ALTER TABLE users ADD COLUMN is_locked INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN lock_reason TEXT;
ALTER TABLE users ADD COLUMN locked_at INTEGER;
ALTER TABLE users ADD COLUMN locked_by TEXT;
ALTER TABLE users ADD COLUMN lock_expires_at INTEGER;

-- Create index for querying locked accounts
CREATE INDEX IF NOT EXISTS idx_users_is_locked ON users(is_locked);
CREATE INDEX IF NOT EXISTS idx_users_lock_expires ON users(lock_expires_at);

-- ============================================================
-- Migration: 0007_oauth_provider.sql
-- ============================================================
-- Migration: OAuth 2.1 / OpenID Connect Provider
-- Enables QTI Auth to act as an OAuth provider ("Sign in with QTI")
-- OAuth clients (third-party apps that want to use "Sign in with QTI")
CREATE TABLE
  IF NOT EXISTS oauth_clients (
    id TEXT PRIMARY KEY,
    client_secret_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    logo_url TEXT,
    homepage_url TEXT,
    privacy_policy_url TEXT,
    redirect_uris TEXT NOT NULL, -- JSON array of allowed redirect URIs
    allowed_scopes TEXT NOT NULL DEFAULT '["openid","profile","email"]', -- JSON array
    client_type TEXT NOT NULL DEFAULT 'confidential', -- 'confidential' or 'public'
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    is_approved INTEGER NOT NULL DEFAULT 0, -- Admin must approve for public use
    FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE CASCADE
  );

-- Authorization codes (short-lived, single use)
CREATE TABLE
  IF NOT EXISTS oauth_authorization_codes (
    code_hash TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    scope TEXT NOT NULL,
    code_challenge TEXT, -- PKCE challenge
    code_challenge_method TEXT, -- S256 only (plain not allowed in OAuth 2.1)
    nonce TEXT, -- OIDC nonce for ID token
    auth_time INTEGER NOT NULL, -- When user authenticated
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (client_id) REFERENCES oauth_clients (id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
  );

-- Access tokens (opaque tokens, stored as hashes)
CREATE TABLE
  IF NOT EXISTS oauth_access_tokens (
    token_hash TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    scope TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (client_id) REFERENCES oauth_clients (id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
  );

-- Refresh tokens (for token rotation)
CREATE TABLE
  IF NOT EXISTS oauth_refresh_tokens (
    token_hash TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    scope TEXT NOT NULL,
    access_token_hash TEXT, -- Associated access token
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (client_id) REFERENCES oauth_clients (id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
  );

-- User consent records (remembers what apps user has authorized)
CREATE TABLE
  IF NOT EXISTS oauth_consents (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    scope TEXT NOT NULL, -- JSON array of granted scopes
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (user_id, client_id),
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    FOREIGN KEY (client_id) REFERENCES oauth_clients (id) ON DELETE CASCADE
  );

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_oauth_clients_created_by ON oauth_clients (created_by);

CREATE INDEX IF NOT EXISTS idx_oauth_clients_is_approved ON oauth_clients (is_approved);

CREATE INDEX IF NOT EXISTS idx_oauth_codes_client ON oauth_authorization_codes (client_id);

CREATE INDEX IF NOT EXISTS idx_oauth_codes_user ON oauth_authorization_codes (user_id);

CREATE INDEX IF NOT EXISTS idx_oauth_codes_expires ON oauth_authorization_codes (expires_at);

CREATE INDEX IF NOT EXISTS idx_oauth_access_client ON oauth_access_tokens (client_id);

CREATE INDEX IF NOT EXISTS idx_oauth_access_user ON oauth_access_tokens (user_id);

CREATE INDEX IF NOT EXISTS idx_oauth_access_expires ON oauth_access_tokens (expires_at);

CREATE INDEX IF NOT EXISTS idx_oauth_refresh_client ON oauth_refresh_tokens (client_id);

CREATE INDEX IF NOT EXISTS idx_oauth_refresh_user ON oauth_refresh_tokens (user_id);

CREATE INDEX IF NOT EXISTS idx_oauth_refresh_expires ON oauth_refresh_tokens (expires_at);

CREATE INDEX IF NOT EXISTS idx_oauth_consents_user ON oauth_consents (user_id);

CREATE INDEX IF NOT EXISTS idx_oauth_consents_client ON oauth_consents (client_id);

ALTER TABLE oauth_clients
ADD COLUMN approval_requested INTEGER NOT NULL DEFAULT 0;

ALTER TABLE oauth_clients
ADD COLUMN approval_requested_at INTEGER;

-- ============================================================
-- Migration: 0008_support.sql
-- ============================================================
-- Migration: Add support system tables (knowledge base + tickets)

CREATE TABLE IF NOT EXISTS kb_articles (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  category TEXT NOT NULL,
  tags TEXT,
  author_id TEXT NOT NULL,
  is_published INTEGER DEFAULT 0,
  view_count INTEGER DEFAULT 0,
  helpful_yes INTEGER DEFAULT 0,
  helpful_no INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  published_at INTEGER,
  FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_kb_articles_slug ON kb_articles(slug);
CREATE INDEX IF NOT EXISTS idx_kb_articles_category ON kb_articles(category);
CREATE INDEX IF NOT EXISTS idx_kb_articles_published ON kb_articles(is_published);
CREATE INDEX IF NOT EXISTS idx_kb_articles_created ON kb_articles(created_at);

CREATE TABLE IF NOT EXISTS support_tickets (
  id TEXT PRIMARY KEY,
  ticket_number INTEGER UNIQUE NOT NULL,
  user_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  category TEXT NOT NULL,
  priority TEXT DEFAULT 'normal',
  status TEXT DEFAULT 'open',
  assigned_to TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  resolved_at INTEGER,
  closed_at INTEGER,
  satisfaction_rating INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (assigned_to) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_tickets_user ON support_tickets(user_id);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON support_tickets(status);
CREATE INDEX IF NOT EXISTS idx_tickets_assigned ON support_tickets(assigned_to);
CREATE INDEX IF NOT EXISTS idx_tickets_created ON support_tickets(created_at);
CREATE INDEX IF NOT EXISTS idx_tickets_priority ON support_tickets(priority);
CREATE INDEX IF NOT EXISTS idx_tickets_number ON support_tickets(ticket_number);

CREATE TABLE IF NOT EXISTS ticket_messages (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  content TEXT NOT NULL,
  is_staff_reply INTEGER DEFAULT 0,
  is_internal_note INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  edited_at INTEGER,
  FOREIGN KEY (ticket_id) REFERENCES support_tickets(id) ON DELETE CASCADE,
  FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_ticket ON ticket_messages(ticket_id);
CREATE INDEX IF NOT EXISTS idx_messages_author ON ticket_messages(author_id);
CREATE INDEX IF NOT EXISTS idx_messages_created ON ticket_messages(created_at);

CREATE TABLE IF NOT EXISTS kb_categories (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  icon TEXT,
  display_order INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ticket_sequence (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  next_number INTEGER NOT NULL DEFAULT 1
);

INSERT OR IGNORE INTO ticket_sequence (id, next_number) VALUES (1, 1);

-- ============================================================
-- Migration: 0009_game_ownership_and_leases.sql
-- ============================================================
-- Migration: Game Ownership and Lease System
-- Tracks which users own which games, and issues/revokes short-lived
-- signed JWT leases for game-server authentication.

CREATE TABLE IF NOT EXISTS games_owned (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  game_id TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  granted_by TEXT,
  UNIQUE (user_id, game_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
  FOREIGN KEY (granted_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_games_owned_user ON games_owned(user_id);
CREATE INDEX IF NOT EXISTS idx_games_owned_game ON games_owned(game_id);

CREATE TABLE IF NOT EXISTS game_leases (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  game_id TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_game_leases_user ON game_leases(user_id);
CREATE INDEX IF NOT EXISTS idx_game_leases_game ON game_leases(game_id);
CREATE INDEX IF NOT EXISTS idx_game_leases_expires ON game_leases(expires_at);
CREATE INDEX IF NOT EXISTS idx_game_leases_revoked ON game_leases(revoked_at);

CREATE TABLE IF NOT EXISTS admin_notification_preferences (
  user_id TEXT PRIMARY KEY,
  notify_new_tickets INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS user_notification_preferences (
  user_id TEXT PRIMARY KEY,
  notify_ticket_updates INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
