import { rpcRequest } from '@qtiauth/bus';
import type { EventActor } from '@qtiauth/events';
import * as z from 'zod';

import type { Context } from './service.ts';

export const GAME_CLIENT_SERVICE = 'oidc';
export const PROVISION_GAME_CLIENT_METHOD = 'provision_game_client';
export const ROTATE_GAME_CLIENT_METHOD = 'rotate_game_client_secret';
export const RETIRE_GAME_CLIENT_METHOD = 'retire_game_client';

const provisionSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), client_id: z.string().min(1), secret: z.string().min(1) }),
  z.object({ status: z.literal('exists'), client_id: z.string().min(1) }),
]);

const rotationSchema = z.object({
  status: z.literal('ok'),
  client_id: z.string().min(1),
  secret: z.string().min(1),
});

export type ProvisionServerClientResult =
  { status: 'ok'; client_id: string; secret: string } | { status: 'exists'; client_id: string };

export async function provisionServerClient(
  ctx: Context,
  options: { gameId: string; name: string; actor: EventActor },
): Promise<ProvisionServerClientResult | undefined> {
  const result = await rpcRequest(ctx.bus, GAME_CLIENT_SERVICE, PROVISION_GAME_CLIENT_METHOD, {
    game_id: options.gameId,
    name: options.name,
    actor: options.actor,
  });
  if (result.status !== 'ok') {
    ctx.log.error('game server client provisioning failed', { outcome: result.status });
    return undefined;
  }
  const parsed = provisionSchema.safeParse(result.data);
  if (!parsed.success) {
    ctx.log.error('game server client provisioning failed', { outcome: 'invalid' });
    return undefined;
  }
  return parsed.data;
}

export async function rotateServerClient(
  ctx: Context,
  options: { gameId: string; actor: EventActor },
): Promise<{ client_id: string; secret: string } | 'missing' | undefined> {
  const result = await rpcRequest(ctx.bus, GAME_CLIENT_SERVICE, ROTATE_GAME_CLIENT_METHOD, {
    game_id: options.gameId,
    actor: options.actor,
  });
  if (result.status === 'error' && result.code === 'not_found') return 'missing';
  if (result.status !== 'ok') {
    ctx.log.error('game server client rotation failed', { outcome: result.status });
    return undefined;
  }
  const parsed = rotationSchema.safeParse(result.data);
  if (!parsed.success) return undefined;
  return { client_id: parsed.data.client_id, secret: parsed.data.secret };
}

export async function retireServerClient(
  ctx: Context,
  options: { gameId: string; actor: EventActor },
): Promise<boolean> {
  const result = await rpcRequest(ctx.bus, GAME_CLIENT_SERVICE, RETIRE_GAME_CLIENT_METHOD, {
    game_id: options.gameId,
    actor: options.actor,
  });
  if (result.status !== 'ok') {
    ctx.log.error('game server client retirement failed', { outcome: result.status });
    return false;
  }
  return true;
}
