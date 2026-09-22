import { type Bus, rpcRequest, writeEvent } from '@qtiauth/bus';
import { queueEmail } from '@qtiauth/email';
import { type EventActor, type EventEnvelope, OIDC_EVENTS } from '@qtiauth/events';
import {
  CONNECTED_APPS_METHOD,
  type ConnectedApp,
  connectedAppsResponseSchema,
  DECIDE_APP_APPROVAL_METHOD,
  decideAppApprovalResponseSchema,
  GUARDIAN_APPS_SERVICE,
  PENDING_APP_APPROVALS_METHOD,
  type PendingAppApproval,
  pendingAppApprovalsResponseSchema,
} from '@qtiauth/service-kit';

import { findAccount } from './accounts.ts';
import type { Database } from './database.ts';
import { type AuditRecordedData, auditRecordedEvent } from './events.ts';
import { childActivity, type ChildActivity, childLabel, listActiveGuardians } from './family.ts';
import type { Context } from './service.ts';
import { familyChildUrl } from './settings.ts';

export async function pendingAppApprovals(bus: Bus, userId: string): Promise<PendingAppApproval[]> {
  const result = await rpcRequest(bus, GUARDIAN_APPS_SERVICE, PENDING_APP_APPROVALS_METHOD, {
    user_id: userId,
  });
  if (result.status !== 'ok') return [];
  const parsed = pendingAppApprovalsResponseSchema.safeParse(result.data);
  return parsed.success ? parsed.data.items : [];
}

export async function connectedApps(
  bus: Bus,
  options: { userId: string; since: Date; until: Date },
): Promise<ConnectedApp[]> {
  const result = await rpcRequest(bus, GUARDIAN_APPS_SERVICE, CONNECTED_APPS_METHOD, {
    user_id: options.userId,
    since: options.since.toISOString(),
    until: options.until.toISOString(),
  });
  if (result.status !== 'ok') return [];
  const parsed = connectedAppsResponseSchema.safeParse(result.data);
  return parsed.success ? parsed.data.items : [];
}

export async function familyChildActivity(
  ctx: Context,
  options: { childUserId: string; now: Date },
): Promise<ChildActivity> {
  const activity = await childActivity(ctx.db, options);
  const apps = await connectedApps(ctx.bus, {
    userId: options.childUserId,
    since: new Date(activity.period_start),
    until: new Date(activity.period_end),
  });
  return { ...activity, connected_apps: apps };
}

export async function decideChildAppApproval(
  ctx: Context,
  options: {
    childUserId: string;
    requestId: string;
    approve: boolean;
    actor: EventActor;
  },
): Promise<'approved' | 'declined' | 'not_found'> {
  const result = await rpcRequest(ctx.bus, GUARDIAN_APPS_SERVICE, DECIDE_APP_APPROVAL_METHOD, {
    user_id: options.childUserId,
    request_id: options.requestId,
    approve: options.approve,
  });
  if (result.status !== 'ok') return 'not_found';
  const parsed = decideAppApprovalResponseSchema.safeParse(result.data);
  if (!parsed.success || parsed.data.status === 'not_found') return 'not_found';
  await ctx.db.transaction().execute(async (trx) => {
    await writeEvent<Database, AuditRecordedData>(
      trx,
      auditRecordedEvent(options.actor, {
        action: options.approve ? 'family.app.approved' : 'family.app.declined',
        target_type: 'user',
        target_id: options.childUserId,
      }),
    );
  });
  ctx.outbox.wake();
  return parsed.data.status;
}

export async function handleOidcFamilyEvent(ctx: Context, event: EventEnvelope): Promise<void> {
  const userId = event.subject?.id;
  if (userId === undefined) return;
  const appName =
    typeof event.data['client_name'] === 'string' ? event.data['client_name'] : undefined;
  if (appName === undefined || appName === '') return;
  const account = await findAccount(ctx.db, userId);
  if (!account || account.state === 'deleted') return;
  const guardians = await listActiveGuardians(ctx.db, userId);
  if (guardians.length === 0) return;
  const template =
    event.type === OIDC_EVENTS.authorizationGuardianRequested
      ? ('guardian_app_approval' as const)
      : event.type === OIDC_EVENTS.clientAuthorized
        ? ('guardian_new_app' as const)
        : undefined;
  if (template === undefined) return;
  const link = familyChildUrl(ctx.config, userId);
  const username = childLabel(account.username);
  for (const guardian of guardians) {
    await queueEmail(ctx.bus, {
      template,
      to: { address: guardian.email },
      locale: account.locale ?? ctx.config.email.default_locale,
      userId: guardian.user_id,
      variables: { username, app_name: appName, link },
    });
  }
}

export function formatConnectedApps(apps: readonly ConnectedApp[]): string {
  if (apps.length === 0) return 'None this week';
  return apps.map((app) => app.name).join(', ');
}
