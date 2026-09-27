import type { NewEvent } from '@qtiauth/bus';
import type { EntitlementSource } from '@qtiauth/config';
import { AUDIT_EVENTS, type EventActor, type GameTrustLevel, GAMES_EVENTS } from '@qtiauth/events';

export const ENTITLEMENT_TRUST: GameTrustLevel = 'game';

export interface EntitlementGrantedData {
  entitlement_id: string;
  user_id: string;
  game_id: string;
  product_id: string;
  source: EntitlementSource;
  trust: GameTrustLevel;
  expires_at: string | null;
}

export interface EntitlementRevokedData {
  entitlement_id: string;
  user_id: string;
  game_id: string;
  product_id: string;
  source: EntitlementSource;
  trust: GameTrustLevel;
  reason: string;
}

export interface AuditRecordedData {
  action: string;
  target_type: string;
  target_id: string;
}

export const SYSTEM_ACTOR: EventActor = { type: 'system', id: 'games' };

export interface AchievementUnlockedData {
  unlock_id: string;
  achievement_id: string;
  user_id: string;
  game_id: string;
  achievement_slug: string;
  trust: GameTrustLevel;
  unlocked_at: string;
}

export interface AchievementProgressedData {
  unlock_id: string;
  achievement_id: string;
  user_id: string;
  game_id: string;
  achievement_slug: string;
  trust: GameTrustLevel;
  progress: number;
  progress_target: number;
}

export interface AchievementRevokedData {
  unlock_id: string;
  achievement_id: string;
  user_id: string;
  game_id: string;
  achievement_slug: string;
  reason: string;
}

export interface StatUpdatedData {
  stat_id: string;
  user_id: string;
  game_id: string;
  stat_key: string;
  trust: GameTrustLevel;
  authority: GameTrustLevel;
  value: number;
  updated_at: string;
}

export interface LeaderboardEntryRemovedData {
  leaderboard_id: string;
  stat_id: string;
  user_id: string;
  game_id: string;
  leaderboard_slug: string;
  period_started_at: string;
  reason: string;
}

export interface PlaytimeEndedData {
  session_id: string;
  user_id: string;
  game_id: string;
  started_at: string;
  ended_at: string;
  duration_seconds: number;
}

export interface LicenseLeaseIssuedData {
  lease_id: string;
  user_id: string;
  game_id: string;
  device_bound: boolean;
  product_count: number;
  issued_at: string;
  expires_at: string;
}

export interface LicenseLeaseRevokedData {
  lease_id: string;
  user_id: string;
  game_id: string;
  reason: string;
}

export function achievementUnlockedEvent(
  data: AchievementUnlockedData,
  actor: EventActor,
): NewEvent<AchievementUnlockedData> {
  return {
    type: GAMES_EVENTS.achievementUnlocked,
    actor,
    subject: { type: 'achievement_unlock', id: data.unlock_id },
    data,
  };
}

export function achievementProgressedEvent(
  data: AchievementProgressedData,
  actor: EventActor,
): NewEvent<AchievementProgressedData> {
  return {
    type: GAMES_EVENTS.achievementProgressed,
    actor,
    subject: { type: 'achievement_unlock', id: data.unlock_id },
    data,
  };
}

export function achievementRevokedEvent(
  data: AchievementRevokedData,
  actor: EventActor,
): NewEvent<AchievementRevokedData> {
  return {
    type: GAMES_EVENTS.achievementRevoked,
    actor,
    subject: { type: 'achievement_unlock', id: data.unlock_id },
    data,
  };
}

export function statUpdatedEvent(
  data: StatUpdatedData,
  actor: EventActor,
): NewEvent<StatUpdatedData> {
  return {
    type: GAMES_EVENTS.statUpdated,
    actor,
    subject: { type: 'stat', id: data.stat_id },
    data,
  };
}

export function leaderboardEntryRemovedEvent(
  data: LeaderboardEntryRemovedData,
  actor: EventActor,
): NewEvent<LeaderboardEntryRemovedData> {
  return {
    type: GAMES_EVENTS.leaderboardEntryRemoved,
    actor,
    subject: { type: 'leaderboard', id: data.leaderboard_id },
    data,
  };
}

export function playtimeEndedEvent(
  data: PlaytimeEndedData,
  actor: EventActor,
): NewEvent<PlaytimeEndedData> {
  return {
    type: GAMES_EVENTS.playtimeSessionEnded,
    actor,
    subject: { type: 'playtime_session', id: data.session_id },
    data,
  };
}

export function entitlementGrantedEvent(
  entitlementId: string,
  data: EntitlementGrantedData,
  actor: EventActor,
): NewEvent<EntitlementGrantedData> {
  return {
    type: GAMES_EVENTS.entitlementGranted,
    actor,
    subject: { type: 'entitlement', id: entitlementId },
    data,
  };
}

export function entitlementRevokedEvent(
  entitlementId: string,
  data: EntitlementRevokedData,
  actor: EventActor,
): NewEvent<EntitlementRevokedData> {
  return {
    type: GAMES_EVENTS.entitlementRevoked,
    actor,
    subject: { type: 'entitlement', id: entitlementId },
    data,
  };
}

export function auditRecordedEvent(
  actor: EventActor,
  data: AuditRecordedData,
): NewEvent<AuditRecordedData> {
  return {
    type: AUDIT_EVENTS.recorded,
    actor,
    subject: { type: data.target_type, id: data.target_id },
    data,
  };
}

export function licenseLeaseIssuedEvent(
  data: LicenseLeaseIssuedData,
  actor: EventActor,
): NewEvent<LicenseLeaseIssuedData> {
  return {
    type: GAMES_EVENTS.licenseLeaseIssued,
    actor,
    subject: { type: 'license_lease', id: data.lease_id },
    data,
  };
}

export function licenseLeaseRevokedEvent(
  data: LicenseLeaseRevokedData,
  actor: EventActor,
): NewEvent<LicenseLeaseRevokedData> {
  return {
    type: GAMES_EVENTS.licenseLeaseRevoked,
    actor,
    subject: { type: 'license_lease', id: data.lease_id },
    data,
  };
}
