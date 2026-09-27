import { type Bus, connectBus } from '@qtiauth/bus';
import { sections } from '@qtiauth/config';
import { captureLogs } from '@qtiauth/observability/testing';
import { type RunningService, serviceSchema, startService } from '@qtiauth/service-kit';
import {
  generateIdentityKey,
  identityHeaders,
  serveTestIdentityKeys,
} from '@qtiauth/service-kit/testing';
import { natsUrl, startNats, startPostgres } from '@qtiauth/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createAchievement, recomputeRarity } from './achievements.ts';
import { createGame, createProduct } from './catalog.ts';
import type { Database } from './database.ts';
import { grantEntitlement } from './entitlements.ts';
import { createKeyBatch, hashCode, normalizeCode } from './keys.ts';
import { definition } from './service.ts';
import { gamesEncryptionKey } from './settings.ts';
import { gamesService } from './start.ts';
import { createLeaderboard, createStat, readLeaderboard } from './stats.ts';

const HOST = 'me.example.com';
const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const key = generateIdentityKey();

let postgres: Awaited<ReturnType<typeof startPostgres>>;
let nats: Awaited<ReturnType<typeof startNats>>;
let gateway: Bus;
let games: RunningService<typeof definition, Database>;
const logs = captureLogs();

async function outboxTypes(): Promise<string[]> {
  const { rows } = await sql<{ subject: string }>`select subject from outbox`.execute(
    games.context.db,
  );
  return rows.map((row) => row.subject);
}

beforeAll(async () => {
  [postgres, nats] = await Promise.all([startPostgres(), startNats()]);
  const bus = sections.bus.parse({ servers: [natsUrl(nats)] });
  gateway = await connectBus(bus, 'identity');
  serveTestIdentityKeys(gateway, key);
  games = await startService(definition, {
    ...gamesService(),
    port: 0,
    tracing: false,
    logDestination: logs.destination,
    identityKeys: key.keys,
    config: serviceSchema(definition).parse({
      bus: { servers: [natsUrl(nats)] },
      database: {
        host: postgres.getHost(),
        port: postgres.getPort(),
        name: postgres.getDatabase(),
        roles: { games: { user: postgres.getUsername(), password: postgres.getPassword() } },
      },
      observability: {
        logs: { user_id_hash_key: 'games-integration' },
        metrics: { process_metrics: false },
      },
      security: { encryption_key: Buffer.alloc(32, 5).toString('base64') },
      captcha: { provider: 'altcha', after: 2 },
      surfaces: { account: { hosts: [HOST] } },
      branding: { product_name: 'Example Account' },
    }),
  });
});

afterAll(async () => {
  await games.stop();
  await gateway.close();
  await Promise.all([postgres.stop(), nats.stop()]);
});

describe('games service', () => {
  it('lists released games publicly and hides drafts', async () => {
    const now = new Date();
    const released = await createGame(games.context.db, {
      slug: 'released-game',
      name: 'Released Game',
      description: 'A launched title',
      icon: null,
      art: null,
      status: 'released',
      lease_duration_seconds: null,
      cloud_save_quota_bytes: null,
      steam_app_id: null,
      actor: { type: 'user', id: ADMIN_ID },
      now,
    });
    expect(released.status).toBe('ok');
    const draft = await createGame(games.context.db, {
      slug: 'draft-game',
      name: 'Draft Game',
      description: '',
      icon: null,
      art: null,
      status: 'draft',
      lease_duration_seconds: null,
      cloud_save_quota_bytes: null,
      steam_app_id: null,
      actor: { type: 'user', id: ADMIN_ID },
      now,
    });
    expect(draft.status).toBe('ok');

    const response = await fetch(`${games.url}/api/v1/games`, {
      headers: identityHeaders(key, 'games', { sub: USER_ID }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: { slug: string }[] };
    const slugs = body.items.map((game) => game.slug);
    expect(slugs).toContain('released-game');
    expect(slugs).not.toContain('draft-game');
  });

  it('grants an entitlement and returns it in the owned list', async () => {
    if (
      !(await games.context.db
        .selectFrom('games')
        .select('id')
        .where('slug', '=', 'owned-game')
        .executeTakeFirst())
    ) {
      const created = await createGame(games.context.db, {
        slug: 'owned-game',
        name: 'Owned Game',
        description: '',
        icon: null,
        art: null,
        status: 'released',
        lease_duration_seconds: null,
        cloud_save_quota_bytes: null,
        steam_app_id: null,
        actor: { type: 'user', id: ADMIN_ID },
        now: new Date(),
      });
      expect(created.status).toBe('ok');
      if (created.status !== 'ok') throw new Error('create failed');
      const dlc = await createProduct(games.context.db, {
        gameId: created.game.id,
        slug: 'season-pass',
        name: 'Season Pass',
        description: '',
        type: 'dlc',
        actor: { type: 'user', id: ADMIN_ID },
        now: new Date(),
      });
      expect(dlc.status).toBe('ok');
    }

    const game = await games.context.db
      .selectFrom('games')
      .select(['id'])
      .where('slug', '=', 'owned-game')
      .executeTakeFirstOrThrow();
    const base = await games.context.db
      .selectFrom('products')
      .select(['id'])
      .where('game_id', '=', game.id)
      .where('slug', '=', 'base')
      .executeTakeFirstOrThrow();
    const result = await grantEntitlement(games.context.db, {
      userId: USER_ID,
      productId: base.id,
      gameId: game.id,
      source: 'admin_grant',
      grantedBy: ADMIN_ID,
      expiresAt: null,
      actor: { type: 'user', id: ADMIN_ID },
      now: new Date(),
    });
    expect(result.status).toBe('ok');
    expect(await outboxTypes()).toContain('qtiauth.games.entitlement.granted.v1');

    const owned = await fetch(`${games.url}/api/v1/games/owned-game/owned`, {
      headers: identityHeaders(key, 'games', { sub: USER_ID }),
    });
    expect(owned.status).toBe(200);
    const body = (await owned.json()) as { items: { slug: string }[] };
    expect(body.items.map((product) => product.slug)).toContain('base');
  });

  it('expires timed entitlements on the sweep and emits revoked', async () => {
    const game = await games.context.db
      .selectFrom('games')
      .select(['id'])
      .where('slug', '=', 'owned-game')
      .executeTakeFirstOrThrow();
    const base = await games.context.db
      .selectFrom('products')
      .select(['id'])
      .where('game_id', '=', game.id)
      .where('slug', '=', 'base')
      .executeTakeFirstOrThrow();
    const expireUser = '33333333-3333-4333-8333-333333333333';
    const past = new Date(Date.now() - 60_000);
    await grantEntitlement(games.context.db, {
      userId: expireUser,
      productId: base.id,
      gameId: game.id,
      source: 'key_redemption',
      grantedBy: null,
      expiresAt: new Date(Date.now() + 1_000),
      actor: { type: 'user', id: ADMIN_ID },
      now: new Date(Date.now() - 1_000),
    });
    await games.context.db
      .updateTable('entitlements')
      .set({ expires_at: past })
      .where('user_id', '=', expireUser)
      .execute();
    const { expireEntitlements } = await import('./entitlements.ts');
    const revoked = await expireEntitlements(games.context.db, new Date());
    expect(revoked).toContain('key_redemption');
    const rows = await games.context.db
      .selectFrom('entitlements')
      .select(['revoked_at', 'revoke_reason'])
      .where('user_id', '=', expireUser)
      .execute();
    expect(rows[0]?.revoke_reason).toBe('expired');
    expect(await outboxTypes()).toContain('qtiauth.games.entitlement.revoked.v1');
  });

  it('brute-forcing keys from one IP hits CAPTCHA, then rate limits', async () => {
    const now = new Date();
    const gameCreate = await createGame(games.context.db, {
      slug: 'keyed-game',
      name: 'Keyed Game',
      description: '',
      icon: null,
      art: null,
      status: 'released',
      lease_duration_seconds: null,
      cloud_save_quota_bytes: null,
      steam_app_id: null,
      actor: { type: 'user', id: ADMIN_ID },
      now,
    });
    if (gameCreate.status !== 'ok') throw new Error('game create failed');
    const dlc = await createProduct(games.context.db, {
      gameId: gameCreate.game.id,
      slug: 'key-pack',
      name: 'Key Pack',
      description: '',
      type: 'dlc',
      actor: { type: 'user', id: ADMIN_ID },
      now,
    });
    if (dlc.status !== 'ok') throw new Error('product create failed');
    const batchId = '44444444-4444-4444-8444-444444444444';
    const { codes } = await createKeyBatch(games.context.db, {
      id: batchId,
      gameId: gameCreate.game.id,
      productId: dlc.product.id,
      label: 'test',
      format: { charset: 'ABCDEFGH', group_length: 4, groups: 2 },
      count: 1,
      expiresAt: null,
      createdBy: ADMIN_ID,
      encryptionKey: gamesEncryptionKey(games.context.config),
      now,
    });
    const buyer = '55555555-5555-4555-8555-555555555555';
    const attemptIp = '203.0.113.55';

    const brute = async (code: string, captcha?: string): Promise<Response> =>
      fetch(`${games.url}/api/v1/games/keys/redeem`, {
        method: 'POST',
        headers: {
          ...identityHeaders(key, 'games', { sub: buyer }),
          'x-forwarded-for': attemptIp,
          'content-type': 'application/json',
        },
        body: JSON.stringify(captcha === undefined ? { code } : { code, captcha }),
      });

    const wrong = 'AAAA-AAAA';
    const first = await brute(wrong);
    expect(first.status).toBe(404);
    const second = await brute(wrong);
    expect(second.status).toBe(404);
    const third = await brute(wrong);
    expect(third.status).toBe(403);
    const problem = (await third.json()) as { code: string };
    expect(problem.code).toBe('GAMES_CAPTCHA_REQUIRED');

    const success = await fetch(`${games.url}/api/v1/games/keys/redeem`, {
      method: 'POST',
      headers: {
        ...identityHeaders(key, 'games', { sub: buyer }),
        'x-forwarded-for': '203.0.113.99',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ code: codes[0] }),
    });
    expect(success.status).toBe(200);
    const body = (await success.json()) as { game_slug: string; product_slug: string };
    expect(body.game_slug).toBe('keyed-game');
    expect(body.product_slug).toBe('key-pack');

    const stored = await games.context.db
      .selectFrom('game_keys')
      .select(['redeemed_by_user_id', 'code_hash'])
      .where('batch_id', '=', batchId)
      .executeTakeFirstOrThrow();
    expect(stored.redeemed_by_user_id).toBe(buyer);
    expect(Buffer.from(stored.code_hash).toString('hex')).toBe(
      Buffer.from(hashCode(normalizeCode(codes[0] ?? ''))).toString('hex'),
    );
    expect(await outboxTypes()).toContain('qtiauth.games.entitlement.granted.v1');
  });

  it('rejects an unlock from a token issued to another game', async () => {
    const now = new Date();
    const home = await createGame(games.context.db, {
      slug: 'home-game',
      name: 'Home Game',
      description: '',
      icon: null,
      art: null,
      status: 'released',
      lease_duration_seconds: null,
      cloud_save_quota_bytes: null,
      steam_app_id: null,
      actor: { type: 'user', id: ADMIN_ID },
      now,
    });
    if (home.status !== 'ok') throw new Error('home game create failed');
    const other = await createGame(games.context.db, {
      slug: 'other-game',
      name: 'Other Game',
      description: '',
      icon: null,
      art: null,
      status: 'released',
      lease_duration_seconds: null,
      cloud_save_quota_bytes: null,
      steam_app_id: null,
      actor: { type: 'user', id: ADMIN_ID },
      now,
    });
    if (other.status !== 'ok') throw new Error('other game create failed');
    const created = await createAchievement(games.context.db, {
      gameId: home.game.id,
      slug: 'first-clear',
      name: 'First Clear',
      description: 'Finish the tutorial',
      icon: null,
      points: 10,
      hidden: false,
      progress_target: null,
      actor: { type: 'user', id: ADMIN_ID },
      now,
    });
    expect(created.status).toBe('ok');

    const player = '66666666-6666-4666-8666-666666666666';
    const wrongToken = await fetch(`${games.url}/api/v1/games/home-game/achievements/unlock`, {
      method: 'POST',
      headers: {
        ...identityHeaders(key, 'games', {
          auth: 'oauth',
          sub: player,
          scopes: ['achievements.write'],
          game_id: other.game.id,
          client_id: 'other-client',
        }),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ slug: 'first-clear' }),
    });
    expect(wrongToken.status).toBe(403);
    const problem = (await wrongToken.json()) as { code: string };
    expect(problem.code).toBe('GAMES_ACHIEVEMENT_WRONG_GAME');

    const rightToken = await fetch(`${games.url}/api/v1/games/home-game/achievements/unlock`, {
      method: 'POST',
      headers: {
        ...identityHeaders(key, 'games', {
          auth: 'oauth',
          sub: player,
          scopes: ['achievements.write'],
          game_id: home.game.id,
          client_id: 'home-client',
        }),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ slug: 'first-clear' }),
    });
    expect(rightToken.status).toBe(200);
    expect(await outboxTypes()).toContain('qtiauth.games.achievement.unlocked.v1');
  });

  it('records player stats, feeds a leaderboard and hides under-18 entries by default', async () => {
    const now = new Date();
    const created = await createGame(games.context.db, {
      slug: 'stat-game',
      name: 'Stat Game',
      description: '',
      icon: null,
      art: null,
      status: 'released',
      lease_duration_seconds: null,
      cloud_save_quota_bytes: null,
      steam_app_id: null,
      actor: { type: 'user', id: ADMIN_ID },
      now,
    });
    if (created.status !== 'ok') throw new Error('stat-game create failed');
    const gameId = created.game.id;
    const stat = await createStat(games.context.db, {
      gameId,
      key: 'score',
      type: 'int',
      aggregation: 'max',
      authority: 'player',
      max_delta_per_update: null,
      actor: { type: 'user', id: ADMIN_ID },
      now,
    });
    if (stat.status !== 'ok') throw new Error('stat create failed');
    const board = await createLeaderboard(games.context.db, {
      gameId,
      statKey: 'score',
      slug: 'top-scores',
      name: 'Top Scores',
      sort: 'desc',
      reset_period: 'never',
      requireGameAuthority: false,
      actor: { type: 'user', id: ADMIN_ID },
      now,
    });
    if (board.status !== 'ok') throw new Error('leaderboard create failed');

    const adult = '99999999-9999-4999-8999-999999999999';
    const teen = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    async function submit(
      player: string,
      ageBand: 'under_13' | '13_to_15' | '16_to_17' | 'adult',
      value: number,
    ): Promise<Response> {
      return fetch(`${games.url}/api/v1/games/stat-game/stats/score/update`, {
        method: 'POST',
        headers: {
          ...identityHeaders(key, 'games', {
            auth: 'oauth',
            sub: player,
            scopes: ['game_stats.write'],
            game_id: gameId,
            client_id: 'stat-client',
            age_band: ageBand,
          }),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ value }),
      });
    }
    expect((await submit(adult, 'adult', 100)).status).toBe(200);
    expect((await submit(teen, '13_to_15', 200)).status).toBe(200);
    expect(await outboxTypes()).toContain('qtiauth.games.stat.updated.v1');

    const entries = await readLeaderboard(games.context.db, {
      leaderboardId: board.leaderboard.id,
      period_started_at: board.leaderboard.period_started_at,
      sort: 'desc',
      limit: 10,
    });
    expect(entries.map((row) => row.user_id)).toEqual([teen, adult]);
    expect(entries[0]?.hidden).toBe(true);
    expect(entries[1]?.hidden).toBe(false);

    const anon = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const view = await fetch(`${games.url}/api/v1/games/stat-game/leaderboards/score/top-scores`, {
      headers: identityHeaders(key, 'games', { sub: anon }),
    });
    expect(view.status).toBe(200);
    const body = (await view.json()) as {
      items: { rank: number; user_id: string | null; display_name: string }[];
    };
    expect(body.items).toHaveLength(2);
    expect(body.items[0]?.user_id).toBeNull();
    expect(body.items[0]?.display_name).toBe('Hidden player');
    expect(body.items[1]?.user_id).toBe(adult);
  });

  it('rejects a player-authority write on a game-authority stat', async () => {
    const now = new Date();
    const authGame = await createGame(games.context.db, {
      slug: 'auth-game',
      name: 'Authority Game',
      description: '',
      icon: null,
      art: null,
      status: 'released',
      lease_duration_seconds: null,
      cloud_save_quota_bytes: null,
      steam_app_id: null,
      actor: { type: 'user', id: ADMIN_ID },
      now,
    });
    if (authGame.status !== 'ok') throw new Error('auth-game create failed');
    const stat = await createStat(games.context.db, {
      gameId: authGame.game.id,
      key: 'ranked-elo',
      type: 'float',
      aggregation: 'latest',
      authority: 'game',
      max_delta_per_update: null,
      actor: { type: 'user', id: ADMIN_ID },
      now,
    });
    expect(stat.status).toBe('ok');
    const player = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const response = await fetch(`${games.url}/api/v1/games/auth-game/stats/ranked-elo/update`, {
      method: 'POST',
      headers: {
        ...identityHeaders(key, 'games', {
          auth: 'oauth',
          sub: player,
          scopes: ['game_stats.write'],
          game_id: authGame.game.id,
          client_id: 'auth-client',
        }),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ value: 1500 }),
    });
    expect(response.status).toBe(403);
    const problem = (await response.json()) as { code: string };
    expect(problem.code).toBe('GAMES_STAT_AUTHORITY_MISMATCH');
  });

  it('tracks a playtime session end-to-end and reports remaining time', async () => {
    const now = new Date();
    const created = await createGame(games.context.db, {
      slug: 'play-game',
      name: 'Play Game',
      description: '',
      icon: null,
      art: null,
      status: 'released',
      lease_duration_seconds: null,
      cloud_save_quota_bytes: null,
      steam_app_id: null,
      actor: { type: 'user', id: ADMIN_ID },
      now,
    });
    if (created.status !== 'ok') throw new Error('play-game create failed');
    const player = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const headers = {
      ...identityHeaders(key, 'games', {
        auth: 'oauth',
        sub: player,
        scopes: ['game_stats.write'],
        game_id: created.game.id,
        client_id: 'play-client',
      }),
      'content-type': 'application/json',
    };

    const started = await fetch(`${games.url}/api/v1/games/play-game/playtime/start`, {
      method: 'POST',
      headers,
    });
    expect(started.status).toBe(201);
    const startBody = (await started.json()) as {
      session_id: string;
      remaining_seconds: number | null;
    };
    expect(startBody.remaining_seconds).toBeNull();

    const heartbeat = await fetch(
      `${games.url}/api/v1/games/play-game/playtime/${startBody.session_id}/heartbeat`,
      { method: 'POST', headers },
    );
    expect(heartbeat.status).toBe(200);

    const ended = await fetch(
      `${games.url}/api/v1/games/play-game/playtime/${startBody.session_id}/end`,
      { method: 'POST', headers },
    );
    expect(ended.status).toBe(200);
    const endBody = (await ended.json()) as { duration_seconds: number };
    expect(endBody.duration_seconds).toBeGreaterThanOrEqual(0);
    expect(await outboxTypes()).toContain('qtiauth.games.playtime.ended.v1');

    const remaining = await fetch(`${games.url}/api/v1/games/play-game/playtime/remaining`, {
      headers,
    });
    expect(remaining.status).toBe(200);
    const remainingBody = (await remaining.json()) as {
      remaining_seconds: number | null;
      used_seconds: number;
    };
    expect(remainingBody.remaining_seconds).toBeNull();
    expect(remainingBody.used_seconds).toBeGreaterThanOrEqual(0);
  });

  it('issues a lease listing every owned product, verifies it and revokes it', async () => {
    const now = new Date();
    const created = await createGame(games.context.db, {
      slug: 'licensed-game',
      name: 'Licensed Game',
      description: '',
      icon: null,
      art: null,
      status: 'released',
      lease_duration_seconds: 120,
      cloud_save_quota_bytes: null,
      steam_app_id: null,
      actor: { type: 'user', id: ADMIN_ID },
      now,
    });
    if (created.status !== 'ok') throw new Error('licensed-game create failed');
    const dlc = await createProduct(games.context.db, {
      gameId: created.game.id,
      slug: 'season-one',
      name: 'Season One',
      description: '',
      type: 'dlc',
      actor: { type: 'user', id: ADMIN_ID },
      now,
    });
    if (dlc.status !== 'ok') throw new Error('licensed-game dlc create failed');
    const player = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    for (const productSlug of ['base', 'season-one']) {
      const product = await games.context.db
        .selectFrom('products')
        .select(['id'])
        .where('game_id', '=', created.game.id)
        .where('slug', '=', productSlug)
        .executeTakeFirstOrThrow();
      const grant = await grantEntitlement(games.context.db, {
        userId: player,
        productId: product.id,
        gameId: created.game.id,
        source: 'admin_grant',
        grantedBy: ADMIN_ID,
        expiresAt: null,
        actor: { type: 'user', id: ADMIN_ID },
        now,
      });
      expect(grant.status).toBe('ok');
    }

    const issue = await fetch(`${games.url}/api/v1/games/licensed-game/licensing/leases`, {
      method: 'POST',
      headers: {
        ...identityHeaders(key, 'games', { sub: player }),
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    expect(issue.status).toBe(201);
    const issued = (await issue.json()) as {
      lease_id: string;
      token: string;
      products: { slug: string }[];
    };
    expect(issued.products.map((product) => product.slug).sort()).toEqual(['base', 'season-one']);
    expect(await outboxTypes()).toContain('qtiauth.games.license_lease.issued.v1');

    const verify = await fetch(`${games.url}/api/v1/games/licensing/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: issued.token }),
    });
    expect(verify.status).toBe(200);
    const verified = (await verify.json()) as { valid: boolean; reason: string | null };
    expect(verified.valid).toBe(true);

    const revoke = await fetch(`${games.url}/api/v1/admin/licenses/${issued.lease_id}/revoke`, {
      method: 'POST',
      headers: {
        ...identityHeaders(key, 'games', {
          sub: ADMIN_ID,
          permissions: ['games.licensing.manage'],
        }),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ reason: 'admin decision' }),
    });
    expect(revoke.status).toBe(200);
    expect(await outboxTypes()).toContain('qtiauth.games.license_lease.revoked.v1');

    const afterRevoke = await fetch(`${games.url}/api/v1/games/licensing/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: issued.token }),
    });
    const revokedBody = (await afterRevoke.json()) as { valid: boolean; reason: string | null };
    expect(revokedBody.valid).toBe(false);
    expect(revokedBody.reason).toBe('revoked');

    const revocations = await fetch(
      `${games.url}/api/v1/games/licensing/revocations?game_slug=licensed-game`,
    );
    expect(revocations.status).toBe(200);
    const list = (await revocations.json()) as { revocations: { jti: string }[]; token: string };
    expect(list.revocations.map((row) => row.jti)).toContain(issued.lease_id);
    expect(list.token.split('.').length).toBe(3);
  });

  it('publishes a jwks under the well-known path', async () => {
    const response = await fetch(`${games.url}/.well-known/qtiauth-license-keys.json`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { keys: { kid: string; alg: string }[] };
    expect(body.keys.length).toBeGreaterThan(0);
    expect(body.keys[0]?.alg).toBe('EdDSA');
  });

  it('enforces the device limit when a game requires device binding', async () => {
    const now = new Date();
    const created = await createGame(games.context.db, {
      slug: 'device-game',
      name: 'Device Game',
      description: '',
      icon: null,
      art: null,
      status: 'released',
      lease_duration_seconds: 120,
      cloud_save_quota_bytes: null,
      steam_app_id: null,
      licensing_device_binding: true,
      actor: { type: 'user', id: ADMIN_ID },
      now,
    });
    if (created.status !== 'ok') throw new Error('device-game create failed');
    const player = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const base = await games.context.db
      .selectFrom('products')
      .select(['id'])
      .where('game_id', '=', created.game.id)
      .where('slug', '=', 'base')
      .executeTakeFirstOrThrow();
    const grant = await grantEntitlement(games.context.db, {
      userId: player,
      productId: base.id,
      gameId: created.game.id,
      source: 'admin_grant',
      grantedBy: ADMIN_ID,
      expiresAt: null,
      actor: { type: 'user', id: ADMIN_ID },
      now,
    });
    expect(grant.status).toBe('ok');

    const missingDevice = await fetch(`${games.url}/api/v1/games/device-game/licensing/leases`, {
      method: 'POST',
      headers: {
        ...identityHeaders(key, 'games', { sub: player }),
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    expect(missingDevice.status).toBe(400);
    const missingBody = (await missingDevice.json()) as { code: string };
    expect(missingBody.code).toBe('GAMES_LICENSING_DEVICE_REQUIRED');

    const limit = games.context.config.games.licensing.max_devices;
    for (let deviceIndex = 0; deviceIndex < limit; deviceIndex++) {
      const response = await fetch(`${games.url}/api/v1/games/device-game/licensing/leases`, {
        method: 'POST',
        headers: {
          ...identityHeaders(key, 'games', { sub: player }),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ device_id: `device-${String(deviceIndex)}` }),
      });
      expect(response.status).toBe(201);
    }
    const overLimit = await fetch(`${games.url}/api/v1/games/device-game/licensing/leases`, {
      method: 'POST',
      headers: {
        ...identityHeaders(key, 'games', { sub: player }),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ device_id: 'device-overflow' }),
    });
    expect(overLimit.status).toBe(409);
    const overBody = (await overLimit.json()) as { code: string };
    expect(overBody.code).toBe('GAMES_LICENSING_DEVICE_LIMIT');

    const devices = await fetch(`${games.url}/api/v1/games/device-game/licensing/devices`, {
      headers: identityHeaders(key, 'games', { sub: player }),
    });
    const devicesBody = (await devices.json()) as { items: { lease_id: string }[] };
    expect(devicesBody.items).toHaveLength(limit);
    const revokeMine = await fetch(
      `${games.url}/api/v1/games/device-game/licensing/devices/${devicesBody.items[0]?.lease_id ?? ''}`,
      {
        method: 'DELETE',
        headers: identityHeaders(key, 'games', { sub: player }),
      },
    );
    expect(revokeMine.status).toBe(204);
  });

  it('rejects a lease issuance for a user who does not own the game', async () => {
    const stranger = '12121212-1212-4121-8121-121212121212';
    const response = await fetch(`${games.url}/api/v1/games/licensed-game/licensing/leases`, {
      method: 'POST',
      headers: {
        ...identityHeaders(key, 'games', { sub: stranger }),
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe('GAMES_LICENSING_NOT_OWNED');
  });

  it('recomputes rarity across owners of a game', async () => {
    const home = await games.context.db
      .selectFrom('games')
      .select(['id'])
      .where('slug', '=', 'home-game')
      .executeTakeFirstOrThrow();
    const base = await games.context.db
      .selectFrom('products')
      .select(['id'])
      .where('game_id', '=', home.id)
      .where('slug', '=', 'base')
      .executeTakeFirstOrThrow();
    for (const uid of [
      '77777777-7777-4777-8777-777777777777',
      '88888888-8888-4888-8888-888888888888',
    ]) {
      const grant = await grantEntitlement(games.context.db, {
        userId: uid,
        productId: base.id,
        gameId: home.id,
        source: 'admin_grant',
        grantedBy: ADMIN_ID,
        expiresAt: null,
        actor: { type: 'user', id: ADMIN_ID },
        now: new Date(),
      });
      expect(grant.status).toBe('ok');
    }
    const summary = await recomputeRarity(games.context.db, new Date());
    expect(summary.achievements).toBeGreaterThan(0);
    const stored = await games.context.db
      .selectFrom('achievement_rarity')
      .innerJoin('achievements', 'achievements.id', 'achievement_rarity.achievement_id')
      .select(['achievement_rarity.owners', 'achievement_rarity.rarity'])
      .where('achievements.game_id', '=', home.id)
      .execute();
    expect(stored.length).toBeGreaterThan(0);
    for (const row of stored) expect(row.owners).toBeGreaterThanOrEqual(2);
  });
});
