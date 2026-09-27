import type { EntitlementSource } from '@qtiauth/config';
import type { Metrics } from '@qtiauth/observability';

export const KEY_REDEMPTION_OUTCOMES = [
  'redeemed',
  'invalid',
  'expired',
  'revoked',
  'already_redeemed',
  'already_owned',
] as const;
export type KeyRedemptionOutcome = (typeof KEY_REDEMPTION_OUTCOMES)[number];

export const CAPTCHA_RESULTS = ['shown', 'solved', 'failed'] as const;
export type CaptchaResult = (typeof CAPTCHA_RESULTS)[number];

export const ACHIEVEMENT_TRUST_LEVELS = ['player', 'game'] as const;
export type AchievementTrustLevel = (typeof ACHIEVEMENT_TRUST_LEVELS)[number];

export const LICENSE_ISSUE_OUTCOMES = [
  'ok',
  'not_owned',
  'device_required',
  'device_limit',
] as const;
export type LicenseIssueOutcome = (typeof LICENSE_ISSUE_OUTCOMES)[number];

export const LICENSE_VERIFY_OUTCOMES = ['valid', 'invalid', 'revoked'] as const;
export type LicenseVerifyOutcome = (typeof LICENSE_VERIFY_OUTCOMES)[number];

export const CLOUD_SAVE_UPLOAD_OUTCOMES = ['ok', 'slot_limit', 'quota', 'conflict'] as const;
export type CloudSaveUploadOutcome = (typeof CLOUD_SAVE_UPLOAD_OUTCOMES)[number];

export const STEAM_AUTH_OUTCOMES = [
  'ok_linked_entitled',
  'ok_linked_unentitled',
  'ok_unlinked',
  'ticket_rejected',
  'family_denied',
  'steam_unavailable',
] as const;
export type SteamAuthOutcome = (typeof STEAM_AUTH_OUTCOMES)[number];

export const STEAM_SYNC_OUTCOMES = ['granted', 'revoked', 'error'] as const;
export type SteamSyncOutcome = (typeof STEAM_SYNC_OUTCOMES)[number];

export interface GamesMetrics {
  granted: (source: EntitlementSource) => void;
  revoked: (source: EntitlementSource) => void;
  keyRedeemed: (outcome: KeyRedemptionOutcome) => void;
  keysGenerated: (count: number) => void;
  captcha: (result: CaptchaResult) => void;
  achievementUnlocked: (trust: AchievementTrustLevel) => void;
  achievementProgressed: (trust: AchievementTrustLevel) => void;
  achievementRevoked: () => void;
  statUpdated: (trust: AchievementTrustLevel) => void;
  leaderboardEntryRemoved: () => void;
  playtimeHeartbeat: () => void;
  playtimeEnded: () => void;
  licenseIssued: (outcome: LicenseIssueOutcome) => void;
  licenseRevoked: () => void;
  licenseVerified: (outcome: LicenseVerifyOutcome) => void;
  licenseKeyLoaded: (createdAt: number) => void;
  licenseKeyRotated: () => void;
  cloudSaveUpload: (outcome: CloudSaveUploadOutcome) => void;
  cloudSaveCommitted: (sizeBytes: number) => void;
  cloudSaveDownloaded: () => void;
  cloudSaveDeleted: () => void;
  steamAuthenticate: (outcome: SteamAuthOutcome) => void;
  steamOwnershipSync: (outcome: SteamSyncOutcome) => void;
}

const created = new WeakMap<Metrics, GamesMetrics>();

export function gamesMetrics(metrics: Metrics): GamesMetrics {
  let games = created.get(metrics);
  if (!games) {
    games = prometheusGamesMetrics(metrics);
    created.set(metrics, games);
  }
  return games;
}

function prometheusGamesMetrics(metrics: Metrics): GamesMetrics {
  const grants = metrics.counter({
    name: 'qtiauth_games_entitlements_granted_total',
    help: 'Entitlements granted, by source.',
    labelNames: ['source'],
  });
  const revokes = metrics.counter({
    name: 'qtiauth_games_entitlements_revoked_total',
    help: 'Entitlements revoked, by source. Expiry counts as a revoke.',
    labelNames: ['source'],
  });
  const keyRedemptions = metrics.counter({
    name: 'qtiauth_games_key_redemptions_total',
    help: 'Key redemption attempts, by outcome.',
    labelNames: ['outcome'],
  });
  const keysGenerated = metrics.counter({
    name: 'qtiauth_games_keys_generated_total',
    help: 'Keys generated across every batch.',
  });
  const captcha = metrics.counter({
    name: 'qtiauth_games_captcha_total',
    help: 'CAPTCHA prompts on key redemption, by result: shown, solved or failed.',
    labelNames: ['result'],
  });
  const achievementUnlocks = metrics.counter({
    name: 'qtiauth_games_achievement_unlocks_total',
    help: 'Achievement unlocks, by trust level.',
    labelNames: ['trust'],
  });
  const achievementProgress = metrics.counter({
    name: 'qtiauth_games_achievement_progress_total',
    help: 'Achievement progress updates that did not unlock, by trust level.',
    labelNames: ['trust'],
  });
  const achievementRevokes = metrics.counter({
    name: 'qtiauth_games_achievement_revokes_total',
    help: 'Achievement unlocks revoked by an admin.',
  });
  const statUpdates = metrics.counter({
    name: 'qtiauth_games_stat_updates_total',
    help: 'Stat updates that changed a value, by trust level.',
    labelNames: ['trust'],
  });
  const leaderboardRemovals = metrics.counter({
    name: 'qtiauth_games_leaderboard_removals_total',
    help: 'Leaderboard entries removed by an admin.',
  });
  const playtimeHeartbeats = metrics.counter({
    name: 'qtiauth_games_playtime_heartbeats_total',
    help: 'Playtime heartbeat writes.',
  });
  const playtimeEndings = metrics.counter({
    name: 'qtiauth_games_playtime_endings_total',
    help: 'Playtime sessions ended, either by the game or by heartbeat lapse.',
  });
  const licenseIssues = metrics.counter({
    name: 'qtiauth_games_license_leases_issued_total',
    help: 'Licence lease issuance attempts, by outcome.',
    labelNames: ['outcome'],
  });
  const licenseRevokes = metrics.counter({
    name: 'qtiauth_games_license_leases_revoked_total',
    help: 'Licence leases revoked before expiry.',
  });
  const licenseVerifies = metrics.counter({
    name: 'qtiauth_games_license_verifications_total',
    help: 'Online licence verifications, by outcome.',
    labelNames: ['outcome'],
  });
  const licenseKey = metrics.gauge({
    name: 'qtiauth_games_license_key_created_at_seconds',
    help: 'When the active licence signing key was created.',
  });
  const licenseKeyRotations = metrics.counter({
    name: 'qtiauth_games_license_key_rotations_total',
    help: 'Licence signing key rotations completed by this replica.',
  });
  const cloudSaveUploads = metrics.counter({
    name: 'qtiauth_games_cloud_save_uploads_total',
    help: 'Cloud save upload requests, by outcome.',
    labelNames: ['outcome'],
  });
  const cloudSaveCommits = metrics.counter({
    name: 'qtiauth_games_cloud_save_commits_total',
    help: 'Cloud save versions that became the current version of a slot.',
  });
  const cloudSaveBytes = metrics.counter({
    name: 'qtiauth_games_cloud_save_committed_bytes_total',
    help: 'Bytes stored in committed cloud save versions.',
  });
  const cloudSaveDownloads = metrics.counter({
    name: 'qtiauth_games_cloud_save_downloads_total',
    help: 'Cloud save download URLs presigned.',
  });
  const cloudSaveDeletes = metrics.counter({
    name: 'qtiauth_games_cloud_save_deletes_total',
    help: 'Cloud save slots deleted by the owner.',
  });
  const steamAuthentications = metrics.counter({
    name: 'qtiauth_games_steam_authenticate_total',
    help: 'Steam ticket authentication attempts, by outcome.',
    labelNames: ['outcome'],
  });
  const steamOwnershipSyncs = metrics.counter({
    name: 'qtiauth_games_steam_ownership_sync_total',
    help: 'Steam ownership sync entitlement changes, by outcome.',
    labelNames: ['outcome'],
  });
  return {
    granted: (source) => {
      grants.inc({ source });
    },
    revoked: (source) => {
      revokes.inc({ source });
    },
    keyRedeemed: (outcome) => {
      keyRedemptions.inc({ outcome });
    },
    keysGenerated: (count) => {
      if (count > 0) keysGenerated.inc(count);
    },
    captcha: (result) => {
      captcha.inc({ result });
    },
    achievementUnlocked: (trust) => {
      achievementUnlocks.inc({ trust });
    },
    achievementProgressed: (trust) => {
      achievementProgress.inc({ trust });
    },
    achievementRevoked: () => {
      achievementRevokes.inc();
    },
    statUpdated: (trust) => {
      statUpdates.inc({ trust });
    },
    leaderboardEntryRemoved: () => {
      leaderboardRemovals.inc();
    },
    playtimeHeartbeat: () => {
      playtimeHeartbeats.inc();
    },
    playtimeEnded: () => {
      playtimeEndings.inc();
    },
    licenseIssued: (outcome) => {
      licenseIssues.inc({ outcome });
    },
    licenseRevoked: () => {
      licenseRevokes.inc();
    },
    licenseVerified: (outcome) => {
      licenseVerifies.inc({ outcome });
    },
    licenseKeyLoaded: (createdAt) => {
      licenseKey.set(Math.floor(createdAt / 1_000));
    },
    licenseKeyRotated: () => {
      licenseKeyRotations.inc();
    },
    cloudSaveUpload: (outcome) => {
      cloudSaveUploads.inc({ outcome });
    },
    cloudSaveCommitted: (sizeBytes) => {
      cloudSaveCommits.inc();
      if (sizeBytes > 0) cloudSaveBytes.inc(sizeBytes);
    },
    cloudSaveDownloaded: () => {
      cloudSaveDownloads.inc();
    },
    cloudSaveDeleted: () => {
      cloudSaveDeletes.inc();
    },
    steamAuthenticate: (outcome) => {
      steamAuthentications.inc({ outcome });
    },
    steamOwnershipSync: (outcome) => {
      steamOwnershipSyncs.inc({ outcome });
    },
  };
}
