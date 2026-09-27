import { GAME_TRUST_LEVELS, GAMES_EVENTS, loadEventCatalog } from '@qtiauth/events';
import { describe, expect, it } from 'vitest';

import { type AchievementRecord, isProgressAchievement, unlockProgress } from './achievements.ts';
import {
  achievementProgressedEvent,
  achievementRevokedEvent,
  achievementUnlockedEvent,
} from './events.ts';

const ID = '01234567-89ab-4def-8123-456789abcdef';

function achievement(overrides: Partial<AchievementRecord> = {}): AchievementRecord {
  return {
    id: ID,
    game_id: ID,
    slug: 'first-win',
    name: 'First Win',
    description: '',
    icon: null,
    points: 10,
    hidden: false,
    progress_target: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('achievement classification', () => {
  it('treats a null or zero target as a one-shot achievement', () => {
    expect(isProgressAchievement(achievement({ progress_target: null }))).toBe(false);
    expect(isProgressAchievement(achievement({ progress_target: 0 }))).toBe(false);
  });

  it('treats a positive target as progress', () => {
    expect(isProgressAchievement(achievement({ progress_target: 100 }))).toBe(true);
  });

  it('caps progress at the target and refuses negative values', () => {
    const record = achievement({ progress_target: 100 });
    expect(unlockProgress(record, 50)).toBe(50);
    expect(unlockProgress(record, 200)).toBe(100);
    expect(unlockProgress(record, -5)).toBe(0);
  });

  it('returns zero progress on non-progress achievements', () => {
    expect(unlockProgress(achievement({ progress_target: null }), 50)).toBe(0);
  });
});

describe('achievement events', () => {
  it('marks the unlock as the subject on every event type', () => {
    const unlocked = achievementUnlockedEvent(
      {
        unlock_id: ID,
        achievement_id: ID,
        user_id: ID,
        game_id: ID,
        achievement_slug: 'first-win',
        trust: 'player',
        unlocked_at: '2026-01-01T00:00:00.000Z',
      },
      { type: 'user', id: ID },
    );
    const progressed = achievementProgressedEvent(
      {
        unlock_id: ID,
        achievement_id: ID,
        user_id: ID,
        game_id: ID,
        achievement_slug: 'first-win',
        trust: 'game',
        progress: 20,
        progress_target: 100,
      },
      { type: 'user', id: ID },
    );
    const revoked = achievementRevokedEvent(
      {
        unlock_id: ID,
        achievement_id: ID,
        user_id: ID,
        game_id: ID,
        achievement_slug: 'first-win',
        reason: 'cheating',
      },
      { type: 'user', id: ID },
    );
    for (const event of [unlocked, progressed, revoked]) {
      expect(event.subject).toEqual({ type: 'achievement_unlock', id: ID });
    }
  });

  it('validates against the shipped schemas', async () => {
    const catalog = await loadEventCatalog();
    const now = new Date().toISOString();
    const envelope = (type: string, data: object) => ({
      event_id: '01H0000000000000000000BEEF',
      type,
      occurred_at: now,
      actor: { type: 'user' as const, id: ID },
      subject: { type: 'achievement_unlock' as const, id: ID },
      data,
      trace_id: null,
      span_id: null,
    });
    expect(
      catalog.validate(
        envelope(GAMES_EVENTS.achievementUnlocked, {
          unlock_id: ID,
          achievement_id: ID,
          user_id: ID,
          game_id: ID,
          achievement_slug: 'first-win',
          trust: 'player',
          unlocked_at: '2026-01-01T00:00:00.000Z',
        }),
      ).valid,
    ).toBe(true);
    expect(
      catalog.validate(
        envelope(GAMES_EVENTS.achievementProgressed, {
          unlock_id: ID,
          achievement_id: ID,
          user_id: ID,
          game_id: ID,
          achievement_slug: 'first-win',
          trust: 'game',
          progress: 20,
          progress_target: 100,
        }),
      ).valid,
    ).toBe(true);
    expect(
      catalog.validate(
        envelope(GAMES_EVENTS.achievementRevoked, {
          unlock_id: ID,
          achievement_id: ID,
          user_id: ID,
          game_id: ID,
          achievement_slug: 'first-win',
          reason: 'cheating',
        }),
      ).valid,
    ).toBe(true);
  });

  it('accepts both player and game trust levels for writes', () => {
    expect([...GAME_TRUST_LEVELS].sort()).toEqual(['game', 'player']);
  });
});
