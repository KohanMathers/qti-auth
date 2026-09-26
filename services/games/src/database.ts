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

export interface Database {
  games: GamesTable;
  products: ProductsTable;
  entitlements: EntitlementsTable;
}
