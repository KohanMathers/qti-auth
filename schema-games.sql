-- Test game data for admins
-- Run this with: wrangler d1 execute qti_auth --remote --file=./schema-games.sql

-- Insert test game
INSERT OR IGNORE INTO games (id, name, slug, description, icon_url, is_active, admin_only, created_at, updated_at)
VALUES (
  'game_test_00000000000000000001',
  'QTI Test Game',
  'test-game',
  'A test game to demonstrate the stats and achievements system. Only admins can see this!',
  NULL,
  1,
  1,
  unixepoch(),
  unixepoch()
);

-- Sample achievements for test game
INSERT OR IGNORE INTO game_achievements (id, game_id, name, description, icon_url, points, created_at)
VALUES
  ('ach_test_first_steps_000001', 'game_test_00000000000000000001', 'First Steps', 'Complete the tutorial', NULL, 10, unixepoch()),
  ('ach_test_beginner_0000002', 'game_test_00000000000000000001', 'Beginner', 'Reach level 5', NULL, 20, unixepoch()),
  ('ach_test_intermediate_003', 'game_test_00000000000000000001', 'Intermediate', 'Reach level 10', NULL, 30, unixepoch()),
  ('ach_test_advanced_0000004', 'game_test_00000000000000000001', 'Advanced', 'Reach level 25', NULL, 50, unixepoch()),
  ('ach_test_master_00000005', 'game_test_00000000000000000001', 'Master', 'Reach level 50', NULL, 100, unixepoch()),
  ('ach_test_speedrunner_006', 'game_test_00000000000000000001', 'Speedrunner', 'Complete a level in under 30 seconds', NULL, 25, unixepoch()),
  ('ach_test_explorer_000007', 'game_test_00000000000000000001', 'Explorer', 'Find all hidden areas', NULL, 40, unixepoch()),
  ('ach_test_perfectionist_8', 'game_test_00000000000000000001', 'Perfectionist', 'Complete the game with 100% completion', NULL, 150, unixepoch());
