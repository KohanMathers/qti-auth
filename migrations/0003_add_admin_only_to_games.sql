-- Migration: Add admin_only flag to games table
-- This allows marking games that should only be visible to admins

-- Add admin_only column to games table (defaults to 0 for normal games)
ALTER TABLE games ADD COLUMN admin_only INTEGER DEFAULT 0;

-- Mark the test game as admin-only
UPDATE games SET admin_only = 1 WHERE slug = 'test-game';
