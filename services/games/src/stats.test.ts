import { GAMES_EVENTS, loadEventCatalog } from '@qtiauth/events';
import { describe, expect, it } from 'vitest';

import { leaderboardEntryRemovedEvent, playtimeEndedEvent, statUpdatedEvent } from './events.ts';
import { aggregateStat } from './stats.ts';

const ID = '01234567-89ab-4def-8123-456789abcdef';

describe('stat aggregation', () => {
  it('sums for sum stats', () => {
    expect(aggregateStat('sum', 10, 5)).toBe(15);
  });

  it('keeps the higher value for max stats', () => {
    expect(aggregateStat('max', 10, 5)).toBe(10);
    expect(aggregateStat('max', 10, 20)).toBe(20);
  });

  it('keeps the lower value for min stats', () => {
    expect(aggregateStat('min', 10, 5)).toBe(5);
    expect(aggregateStat('min', 10, 20)).toBe(10);
  });

  it('replaces with the incoming value for latest stats', () => {
    expect(aggregateStat('latest', 10, 5)).toBe(5);
  });
});

describe('stat events', () => {
  it('names the stat as subject on stat.updated', () => {
    const event = statUpdatedEvent(
      {
        stat_id: ID,
        user_id: ID,
        game_id: ID,
        stat_key: 'kills',
        trust: 'player',
        authority: 'player',
        value: 42,
        updated_at: '2026-01-01T00:00:00.000Z',
      },
      { type: 'user', id: ID },
    );
    expect(event.subject).toEqual({ type: 'stat', id: ID });
  });

  it('names the leaderboard as subject on the removal event', () => {
    const event = leaderboardEntryRemovedEvent(
      {
        leaderboard_id: ID,
        stat_id: ID,
        user_id: ID,
        game_id: ID,
        leaderboard_slug: 'top-scores',
        period_started_at: '2026-01-01T00:00:00.000Z',
        reason: 'cheating',
      },
      { type: 'user', id: ID },
    );
    expect(event.subject).toEqual({ type: 'leaderboard', id: ID });
  });

  it('names the session as subject on the playtime event', () => {
    const event = playtimeEndedEvent(
      {
        session_id: ID,
        user_id: ID,
        game_id: ID,
        started_at: '2026-01-01T00:00:00.000Z',
        ended_at: '2026-01-01T00:30:00.000Z',
        duration_seconds: 1_800,
      },
      { type: 'user', id: ID },
    );
    expect(event.subject).toEqual({ type: 'playtime_session', id: ID });
  });

  it('validates against the shipped schemas', async () => {
    const catalog = await loadEventCatalog();
    const now = new Date().toISOString();
    const envelope = (type: string, subject: { type: string; id: string }, data: object) => ({
      event_id: '01H0000000000000000000BEEF',
      type,
      occurred_at: now,
      actor: { type: 'user' as const, id: ID },
      subject,
      data,
      trace_id: null,
      span_id: null,
    });
    expect(
      catalog.validate(
        envelope(
          GAMES_EVENTS.statUpdated,
          { type: 'stat', id: ID },
          {
            stat_id: ID,
            user_id: ID,
            game_id: ID,
            stat_key: 'kills',
            trust: 'game',
            authority: 'game',
            value: 42,
            updated_at: '2026-01-01T00:00:00.000Z',
          },
        ),
      ).valid,
    ).toBe(true);
    expect(
      catalog.validate(
        envelope(
          GAMES_EVENTS.leaderboardEntryRemoved,
          { type: 'leaderboard', id: ID },
          {
            leaderboard_id: ID,
            stat_id: ID,
            user_id: ID,
            game_id: ID,
            leaderboard_slug: 'top-scores',
            period_started_at: '2026-01-01T00:00:00.000Z',
            reason: 'cheating',
          },
        ),
      ).valid,
    ).toBe(true);
    expect(
      catalog.validate(
        envelope(
          GAMES_EVENTS.playtimeSessionEnded,
          { type: 'playtime_session', id: ID },
          {
            session_id: ID,
            user_id: ID,
            game_id: ID,
            started_at: '2026-01-01T00:00:00.000Z',
            ended_at: '2026-01-01T00:30:00.000Z',
            duration_seconds: 1_800,
          },
        ),
      ).valid,
    ).toBe(true);
  });
});
