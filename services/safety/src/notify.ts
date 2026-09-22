import { rpcRequest } from '@qtiauth/bus';
import { queueEmail } from '@qtiauth/email';
import {
  USER_CLAIMS_METHOD,
  USER_CLAIMS_SERVICE,
  type UserClaimsResponse,
} from '@qtiauth/service-kit';

import { ruleOf, type ModerationCatalog } from './catalog.ts';
import { durationLabel, type AppliedAction } from './moderation.ts';
import { appealUrl } from './origin.ts';
import type { Context } from './service.ts';

async function userEmail(ctx: Context, userId: string): Promise<string | null> {
  const result = await rpcRequest<UserClaimsResponse>(
    ctx.bus,
    USER_CLAIMS_SERVICE,
    USER_CLAIMS_METHOD,
    {
      user_id: userId,
    },
  );
  if (result.status !== 'ok' || result.data.user === null) return null;
  return result.data.user.email;
}

export async function queueStatementOfReasons(
  ctx: Context,
  catalog: ModerationCatalog,
  action: AppliedAction,
): Promise<void> {
  if (action.user_id === null) return;
  const rule = ruleOf(catalog, action.rule_id);
  const link = appealUrl(ctx.config.surfaces, action.id);
  if (!rule || link === undefined) return;
  const address = await userEmail(ctx, action.user_id);
  if (address === null) return;
  const defined = catalog.actions.get(action.action);
  await queueEmail(ctx.bus, {
    template: 'moderation_action',
    to: { address },
    locale: ctx.config.email.default_locale,
    userId: action.user_id,
    variables: {
      action: defined?.name ?? action.action,
      rule: rule.name,
      summary: rule.summary,
      duration: durationLabel(action, new Date()),
      appeal_link: link,
    },
  });
}

export async function queueAppealOutcome(
  ctx: Context,
  action: AppliedAction,
  outcome: 'lifted' | 'upheld',
): Promise<void> {
  if (action.user_id === null) return;
  const address = await userEmail(ctx, action.user_id);
  if (address === null) return;
  const defined = catalogActionName(ctx, action.action);
  await queueEmail(ctx.bus, {
    template: 'moderation_appeal_outcome',
    to: { address },
    locale: ctx.config.email.default_locale,
    userId: action.user_id,
    variables: {
      action: defined,
      outcome: outcome === 'lifted' ? 'lifted' : 'left in place',
    },
  });
}

function catalogActionName(ctx: Context, action: string): string {
  return ctx.config.safety.actions.types[action]?.name ?? action;
}
