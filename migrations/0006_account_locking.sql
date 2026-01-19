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
