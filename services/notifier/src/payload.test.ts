import { describe, expect, it } from 'vitest';

import { adminLink, discordBody, minimizeData, slackBody, webhookPayload } from './payload.ts';

describe('webhook payloads', () => {
  it('keeps ids, types, trust and timestamps and drops content', () => {
    expect(
      minimizeData({
        reason: 'spam',
        trust: 'game',
        report_id: 'r1',
        content: 'a snapshot',
        description: 'user said a thing',
        reporter_id: 'u1',
        body: 'secret',
        evidence: 'held',
        number: 12,
        category: 'account',
        appeal: false,
      }),
    ).toEqual({
      reason: 'spam',
      trust: 'game',
      report_id: 'r1',
      number: 12,
      category: 'account',
      appeal: false,
    });
  });

  it('builds a Discord embed and a Slack message a human can read', () => {
    const payload = webhookPayload(
      {
        event_id: '01J8ZQ4Y3N5W7R9T1V3X5Z7B9D',
        occurred_at: '2026-09-16T12:00:00.000Z',
        subject: { type: 'user', id: 'user-1' },
        data: { reason: 'spam', trust: 'player' },
      },
      'identity.user.banned',
      { account: 'https://me.example.com', support: 'https://me.example.com/support' },
    );
    expect(payload.admin_url).toBe('https://me.example.com/admin/users/user-1');
    expect(adminLink('safety.report.created', { type: 'report', id: 'rep-1' })).toEqual({
      surface: 'account',
      path: '/admin/moderation/rep-1',
    });
    expect(adminLink('support.ticket.created', { type: 'ticket', id: 'tix-1' })).toEqual({
      surface: 'support',
      path: '/staff/tickets/tix-1',
    });
    expect(adminLink('oidc.client.created', { type: 'oauth_client', id: 'app-1' })).toEqual({
      surface: 'account',
      path: '/admin/oauth/app-1',
    });

    const discord = JSON.parse(discordBody(payload)) as {
      embeds: { title: string; fields: { name: string; value: string }[] }[];
    };
    expect(discord.embeds[0]?.title).toContain('identity.user.banned');
    expect(discord.embeds[0]?.fields.map((field) => field.value).join(' ')).toContain('spam');

    const slack = JSON.parse(slackBody(payload)) as { text: string; blocks: { type: string }[] };
    expect(slack.text).toBe('identity.user.banned');
    expect(slack.blocks.some((block) => block.type === 'section')).toBe(true);
  });
});
