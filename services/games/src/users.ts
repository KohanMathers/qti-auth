import { rpcRequest } from '@qtiauth/bus';
import {
  USER_CLAIMS_METHOD,
  USER_CLAIMS_SERVICE,
  userClaimsResponseSchema,
} from '@qtiauth/service-kit';

import type { Context } from './service.ts';

export async function accountExists(
  ctx: Context,
  userId: string,
): Promise<'ok' | 'missing' | 'unavailable'> {
  const result = await rpcRequest(ctx.bus, USER_CLAIMS_SERVICE, USER_CLAIMS_METHOD, {
    user_id: userId,
  });
  if (result.status !== 'ok') return 'unavailable';
  const parsed = userClaimsResponseSchema.safeParse(result.data);
  if (!parsed.success) return 'unavailable';
  return parsed.data.user === null ? 'missing' : 'ok';
}
