import type { EntitlementSource, GameStatus, ProductType } from '@qtiauth/config';

export interface GamesTable {
  id: string;
  slug: string;
  name: string;
  description: string;
  icon: string | null;
  art: string | null;
  status: GameStatus;
  lease_duration_seconds: number | null;
  cloud_save_quota_bytes: string | null;
  steam_app_id: number | null;
  server_client_id: string | null;
  licensing_device_binding: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface LeasedProduct {
  slug: string;
  type: ProductType;
  expires_at: string | null;
}

export interface LicenseLeasesTable {
  id: string;
  user_id: string;
  game_id: string;
  device_hash: string | null;
  device_label: string | null;
  products: LeasedProduct[];
  issued_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  revoke_reason: string | null;
  last_seen_at: Date | null;
  created_at: Date;
}

export interface LicenseRevocationsTable {
  lease_id: string;
  game_id: string;
  user_id: string;
  revoked_at: Date;
  expires_at: Date;
  reason: string | null;
}

export interface ProductsTable {
  id: string;
  game_id: string;
  slug: string;
  name: string;
  description: string;
  type: ProductType;
  created_at: Date;
  updated_at: Date;
}

export interface EntitlementsTable {
  id: string;
  user_id: string;
  product_id: string;
  source: EntitlementSource;
  granted_by: string | null;
  granted_at: Date;
  expires_at: Date | null;
  revoked_at: Date | null;
  revoke_reason: string | null;
  created_at: Date;
}

export interface KeyBatchesTable {
  id: string;
  game_id: string;
  product_id: string;
  label: string;
  format: string;
  total_keys: number;
  expires_at: Date | null;
  created_by: string | null;
  created_at: Date;
  revoked_at: Date | null;
  revoke_reason: string | null;
}

export interface GameKeysTable {
  id: string;
  batch_id: string;
  code_hash: Uint8Array;
  code_display: string;
  code_sealed: string;
  redeemed_by_user_id: string | null;
  redeemed_at: Date | null;
  redeemed_ip: string | null;
  entitlement_id: string | null;
  revoked_at: Date | null;
  created_at: Date;
}

export interface KeyRedeemAttemptsTable {
  ip: string;
  attempts: number;
  updated_at: Date;
}

export interface AchievementsTable {
  id: string;
  game_id: string;
  slug: string;
  name: string;
  description: string;
  icon: string | null;
  points: number;
  hidden: boolean;
  progress_target: number | null;
  created_at: Date;
  updated_at: Date;
}

export interface AchievementUnlocksTable {
  id: string;
  achievement_id: string;
  user_id: string;
  progress: number;
  unlocked_at: Date | null;
  revoked_at: Date | null;
  revoke_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface AchievementRarityTable {
  achievement_id: string;
  owners: number;
  unlocks: number;
  rarity: number;
  computed_at: Date;
}

export type StatType = 'int' | 'float' | 'duration';
export type StatAggregation = 'sum' | 'max' | 'min' | 'latest';
export type StatAuthority = 'player' | 'game';
export type LeaderboardSort = 'asc' | 'desc';
export type LeaderboardResetPeriod = 'never' | 'daily' | 'weekly' | 'monthly' | `season:${string}`;

export interface StatDefinitionsTable {
  id: string;
  game_id: string;
  key: string;
  type: StatType;
  aggregation: StatAggregation;
  authority: StatAuthority;
  max_delta_per_update: number | null;
  created_at: Date;
  updated_at: Date;
}

export interface StatValuesTable {
  stat_id: string;
  user_id: string;
  value: number;
  updates: number;
  updated_at: Date;
  created_at: Date;
}

export interface StatCustomDataTable {
  game_id: string;
  user_id: string;
  data: Record<string, unknown>;
  updated_at: Date;
}

export interface LeaderboardsTable {
  id: string;
  stat_id: string;
  slug: string;
  name: string;
  sort: LeaderboardSort;
  reset_period: LeaderboardResetPeriod;
  period_started_at: Date;
  period_ends_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface LeaderboardEntriesTable {
  leaderboard_id: string;
  period_started_at: Date;
  user_id: string;
  score: number;
  hidden: boolean;
  removed_at: Date | null;
  removed_reason: string | null;
  updated_at: Date;
}

export interface PlaytimeSessionsTable {
  id: string;
  user_id: string;
  game_id: string;
  started_at: Date;
  last_heartbeat_at: Date;
  ended_at: Date | null;
  duration_seconds: number;
  created_at: Date;
}

export interface PlaytimeDailyTable {
  user_id: string;
  game_id: string;
  day: Date;
  seconds: number;
  updated_at: Date;
}

export interface CloudSaveSlotsTable {
  id: string;
  user_id: string;
  game_id: string;
  slot: string;
  current_version_id: string | null;
  size_bytes: string;
  created_at: Date;
  updated_at: Date;
}

export interface CloudSaveVersionsTable {
  id: string;
  slot_id: string;
  version: number;
  size_bytes: string;
  object_key: string;
  content_type: string;
  committed_at: Date | null;
  created_at: Date;
}

export interface Database {
  games: GamesTable;
  products: ProductsTable;
  entitlements: EntitlementsTable;
  key_batches: KeyBatchesTable;
  game_keys: GameKeysTable;
  key_redeem_attempts: KeyRedeemAttemptsTable;
  achievements: AchievementsTable;
  achievement_unlocks: AchievementUnlocksTable;
  achievement_rarity: AchievementRarityTable;
  stat_definitions: StatDefinitionsTable;
  stat_values: StatValuesTable;
  stat_custom_data: StatCustomDataTable;
  leaderboards: LeaderboardsTable;
  leaderboard_entries: LeaderboardEntriesTable;
  playtime_sessions: PlaytimeSessionsTable;
  playtime_daily: PlaytimeDailyTable;
  license_leases: LicenseLeasesTable;
  license_revocations: LicenseRevocationsTable;
  cloud_save_slots: CloudSaveSlotsTable;
  cloud_save_versions: CloudSaveVersionsTable;
}
