-- Disable foreign key checks temporarily (D1/SQLite)
PRAGMA foreign_keys = OFF;

-- Core user table
UPDATE users SET id = 'ba47be25-2752-4aab-a200-7ba66ab216c0' WHERE id = 'ba47be25-2752-4aab-a200-7ba66ab216c';

-- Username related
UPDATE username_history SET user_id = 'ba47be25-2752-4aab-a200-7ba66ab216c0' WHERE user_id = 'ba47be25-2752-4aab-a200-7ba66ab216c';
UPDATE username_cooldowns SET user_id = 'ba47be25-2752-4aab-a200-7ba66ab216c0' WHERE user_id = 'ba47be25-2752-4aab-a200-7ba66ab216c';

-- Reports/moderation (multiple columns)
UPDATE user_reports SET reporter_user_id = 'ba47be25-2752-4aab-a200-7ba66ab216c0' WHERE reporter_user_id = 'ba47be25-2752-4aab-a200-7ba66ab216c';
UPDATE user_reports SET reported_user_id = 'ba47be25-2752-4aab-a200-7ba66ab216c0' WHERE reported_user_id = 'ba47be25-2752-4aab-a200-7ba66ab216c';
UPDATE user_reports SET reviewed_by = 'ba47be25-2752-4aab-a200-7ba66ab216c0' WHERE reviewed_by = 'ba47be25-2752-4aab-a200-7ba66ab216c';
UPDATE moderation_actions SET user_id = 'ba47be25-2752-4aab-a200-7ba66ab216c0' WHERE user_id = 'ba47be25-2752-4aab-a200-7ba66ab216c';
UPDATE moderation_actions SET moderator_id = 'ba47be25-2752-4aab-a200-7ba66ab216c0' WHERE moderator_id = 'ba47be25-2752-4aab-a200-7ba66ab216c';
UPDATE content_flags SET user_id = 'ba47be25-2752-4aab-a200-7ba66ab216c0' WHERE user_id = 'ba47be25-2752-4aab-a200-7ba66ab216c';
UPDATE content_flags SET reviewed_by = 'ba47be25-2752-4aab-a200-7ba66ab216c0' WHERE reviewed_by = 'ba47be25-2752-4aab-a200-7ba66ab216c';
UPDATE admin_logs SET admin_id = 'ba47be25-2752-4aab-a200-7ba66ab216c0' WHERE admin_id = 'ba47be25-2752-4aab-a200-7ba66ab216c';

-- Game stats
UPDATE user_achievements SET user_id = 'ba47be25-2752-4aab-a200-7ba66ab216c0' WHERE user_id = 'ba47be25-2752-4aab-a200-7ba66ab216c';
UPDATE user_game_stats SET user_id = 'ba47be25-2752-4aab-a200-7ba66ab216c0' WHERE user_id = 'ba47be25-2752-4aab-a200-7ba66ab216c';

-- Minecraft
UPDATE minecraft_accounts SET user_id = 'ba47be25-2752-4aab-a200-7ba66ab216c0' WHERE user_id = 'ba47be25-2752-4aab-a200-7ba66ab216c';
UPDATE minecraft_link_codes SET used_by_user_id = 'ba47be25-2752-4aab-a200-7ba66ab216c0' WHERE used_by_user_id = 'ba47be25-2752-4aab-a200-7ba66ab216c';
UPDATE minecraft_unlink_cooldowns SET user_id = 'ba47be25-2752-4aab-a200-7ba66ab216c0' WHERE user_id = 'ba47be25-2752-4aab-a200-7ba66ab216c';
-- Re-enable foreign keys
PRAGMA foreign_keys = ON;
