import { USERNAME_MAX_LENGTH } from '@qtiauth/config';
import { ProblemError, type Router } from '@qtiauth/service-kit';
import * as z from 'zod';

import { SIGNED_IN_STATES } from './accounts.ts';
import { chooseUsername } from './flows.ts';
import { NO_STORE } from './headers.ts';
import type { Context } from './service.ts';
import { signedIn } from './session-routes.ts';
import type { ClaimUsernameResult } from './usernames.ts';

const usernameBody = z.object({
  username: z.string().min(1).max(USERNAME_MAX_LENGTH).describe('The username to claim.'),
});

const usernameSchema = z.object({
  username: z.string(),
  updated_at: z.iso.datetime(),
});

function usernameError(result: Exclude<ClaimUsernameResult, { status: 'saved' }>): never {
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
    handler: async ({ ctx, identity, body, request, log }) => {
      const { userId } = signedIn(identity);
      const result = await chooseUsername(
        { ctx, request, log },
        { userId, username: body.username },
      );
      if (result.status !== 'saved') usernameError(result);
      return {
        status: 200,
        headers: NO_STORE,
        body: { username: result.username, updated_at: result.updatedAt.toISOString() },
      };
    },
  });
}
