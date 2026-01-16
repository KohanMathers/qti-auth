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
