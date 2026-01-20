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