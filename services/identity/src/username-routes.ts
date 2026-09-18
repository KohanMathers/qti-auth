import { USERNAME_MAX_LENGTH } from '@qtiauth/config';
import { ProblemError, type Router } from '@qtiauth/service-kit';
import * as z from 'zod';

import { SIGNED_IN_STATES } from './accounts.ts';
import { NO_STORE } from './headers.ts';
import type { Context } from './service.ts';
import { signedIn } from './session-routes.ts';
import { claimUsername } from './usernames.ts';

const usernameBody = z.object({
  username: z.string().min(1).max(USERNAME_MAX_LENGTH).describe('The username to claim.'),
});

const usernameSchema = z.object({
  username: z.string(),
  updated_at: z.iso.datetime(),
});

export async function setUsername(
  ctx: Context,
  options: { userId: string; username: string },
): Promise<{ username: string; updated_at: string }> {
  const result = await claimUsername(ctx, {
    userId: options.userId,
    username: options.username,
    now: new Date(),
  });
  switch (result.status) {
    case 'not_found':
      throw new ProblemError('ACCOUNT_NOT_FOUND');
    case 'invalid':
      throw new ProblemError('USERNAME_INVALID');
    case 'unavailable':
      throw new ProblemError('USERNAME_UNAVAILABLE');
    case 'unchanged':
      throw new ProblemError('USERNAME_UNCHANGED');
    case 'cooldown':
      throw new ProblemError('USERNAME_COOLDOWN', {
        extensions: { available_at: result.availableAt.toISOString() },
      });
    case 'limit':
      throw new ProblemError('USERNAME_CHANGE_LIMIT');
    case 'claimed':
    case 'changed':
    case 'reclaimed':
      ctx.outbox.wake();
      return { username: result.username, updated_at: result.updatedAt.toISOString() };
  }
}

export function usernameRoutes(router: Router<Context>): void {
  router.route({
    method: 'POST',
    path: '/api/v1/me/username',
    operation_id: 'setUsername',
    summary: 'Claim a username, or change it',
    description:
      'Accounts can exist without a username. Changing one is limited by usernames.change_cooldown and usernames.changes_per_year. Taken, reserved and filtered names all answer Username not available.',
    tags: ['account'],
    auth: 'session',
    allow_account_states: SIGNED_IN_STATES,
    rate_limit: 'global',
    request: { body: usernameBody },
    responses: {
      200: { description: 'The username is now this account’s', schema: usernameSchema },
    },
    errors: [
      'ACCOUNT_NOT_FOUND',
      'USERNAME_INVALID',
      'USERNAME_UNAVAILABLE',
      'USERNAME_UNCHANGED',
      'USERNAME_COOLDOWN',
      'USERNAME_CHANGE_LIMIT',
    ],
    handler: async ({ ctx, identity, body, log }) => {
      const { userId } = signedIn(identity);
      const username = await setUsername(ctx, { userId, username: body.username });
      log.info('username set', { user_id: userId });
      return { status: 200, headers: NO_STORE, body: username };
    },
  });
}
