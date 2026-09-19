import {
  decodeCursor,
  pageOf,
  pageSchema,
  paginationQuery,
  ProblemError,
  type Router,
} from '@qtiauth/service-kit';
import * as z from 'zod';

import type { Context } from './service.ts';
import { AUTHORIZED_PATH } from './settings.ts';

const position = z.object({ granted_at: z.iso.datetime(), client_id: z.uuid() });

const authorizedSchema = z.object({
  client_id: z.string(),
  name: z.string(),
  scopes: z.array(z.string()),
  granted_at: z.iso.datetime(),
});

function signedIn(identity: { sub: string | null }): string {
  if (identity.sub === null) throw new ProblemError('CLIENT_NOT_FOUND');
  return identity.sub;
}

export function authorizedRoutes(router: Router<Context>): void {
  router.route({
    method: 'GET',
    path: AUTHORIZED_PATH,
    operation_id: 'listAuthorizedClients',
    summary: 'List OAuth clients the signed-in user has authorized',
    tags: ['oidc'],
    auth: 'session',
    rate_limit: 'global',
    request: { query: paginationQuery({ defaultLimit: 20, maxLimit: 100 }) },
    responses: {
      200: { description: 'Authorized clients', schema: pageSchema(authorizedSchema) },
    },
    handler: async ({ ctx, identity, query }) => {
      const userId = signedIn(identity);
      const after = decodeCursor(position, query.cursor);
      let listing = ctx.db
        .selectFrom('consents')
        .innerJoin('clients', 'clients.id', 'consents.client_id')
        .select([
          'clients.id as id',
          'clients.client_id as client_id',
          'clients.name as name',
          'consents.scopes as scopes',
          'consents.granted_at as granted_at',
        ])
        .where('consents.user_id', '=', userId)
        .orderBy('consents.granted_at', 'desc')
        .orderBy('consents.client_id', 'desc')
        .limit(query.limit + 1);
      if (after) {
        listing = listing.where((eb) =>
          eb.or([
            eb('consents.granted_at', '<', new Date(after.granted_at)),
            eb.and([
              eb('consents.granted_at', '=', new Date(after.granted_at)),
              eb('consents.client_id', '<', after.client_id),
            ]),
          ]),
        );
      }
      const rows = await listing.execute();
      const page = pageOf(rows, query.limit, (row) => ({
        granted_at: row.granted_at.toISOString(),
        client_id: row.id,
      }));
      return {
        status: 200,
        headers: { 'cache-control': 'no-store' },
        body: {
          next_cursor: page.next_cursor,
          items: page.items.map((row) => ({
            client_id: row.client_id,
            name: row.name,
            scopes: row.scopes,
            granted_at: row.granted_at.toISOString(),
          })),
        },
      };
    },
  });

  router.route({
    method: 'DELETE',
    path: `${AUTHORIZED_PATH}/:client_id`,
    operation_id: 'revokeAuthorizedClient',
    summary: 'Revoke an OAuth client’s access to the signed-in user’s account',
    tags: ['oidc'],
    auth: 'session',
    rate_limit: 'global',
    request: {
      params: z.object({ client_id: z.string().min(1).max(64) }),
    },
    responses: { 204: { description: 'Authorization revoked' } },
    errors: ['CLIENT_NOT_FOUND'],
    handler: async ({ ctx, identity, params }) => {
      const userId = signedIn(identity);
      const now = new Date();
      const client = await ctx.db
        .selectFrom('clients')
        .select('id')
        .where('client_id', '=', params.client_id)
        .executeTakeFirst();
      if (!client) throw new ProblemError('CLIENT_NOT_FOUND');
      const consent = await ctx.db
        .selectFrom('consents')
        .select('client_id')
        .where('user_id', '=', userId)
        .where('client_id', '=', client.id)
        .executeTakeFirst();
      if (!consent) throw new ProblemError('CLIENT_NOT_FOUND');
      await ctx.db.transaction().execute(async (trx) => {
        await trx
          .deleteFrom('consents')
          .where('user_id', '=', userId)
          .where('client_id', '=', client.id)
          .execute();
        await trx
          .updateTable('refresh_tokens')
          .set({ revoked_at: now })
          .where('user_id', '=', userId)
          .where('client_id', '=', client.id)
          .where('revoked_at', 'is', null)
          .execute();
        await trx
          .updateTable('access_tokens')
          .set({ revoked_at: now })
          .where('user_id', '=', userId)
          .where('client_id', '=', client.id)
          .where('revoked_at', 'is', null)
          .execute();
      });
      return { status: 204, headers: { 'cache-control': 'no-store' } };
    },
  });
}
