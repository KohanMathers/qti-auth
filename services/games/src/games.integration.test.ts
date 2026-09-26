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

import { createGame, createProduct } from './catalog.ts';
import type { Database } from './database.ts';
import { grantEntitlement } from './entitlements.ts';
import { definition } from './service.ts';
import { gamesService } from './start.ts';

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
});
