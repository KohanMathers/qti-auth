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
  created_at: Date;
  updated_at: Date;
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
}
