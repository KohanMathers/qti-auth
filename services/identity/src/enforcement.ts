import { writeEvent } from '@qtiauth/bus';
import { SAFETY_ACTIONS, type SafetyActionType } from '@qtiauth/config';
import { updatedRows } from '@qtiauth/db';
import { queueEmail } from '@qtiauth/email';
import { type EventActor, type EventEnvelope, SAFETY_EVENTS } from '@qtiauth/events';
import type { AccountState } from '@qtiauth/service-kit';
import type { Kysely } from 'kysely';
import * as z from 'zod';

import { recordAccountAction } from './account-locks.ts';
import { canTransition, findAccount } from './accounts.ts';
import type { Database } from './database.ts';
import {
  type UserBannedData,
  type UserLockedData,
  type UserUnbannedData,
  type UserUnlockedData,
  type UserUpdatedData,
  userBannedEvent,
  userLockedEvent,
  userUnbannedEvent,
  userUnlockedEvent,
  userUpdatedEvent,
} from './events.ts';
import { childLabel, listActiveGuardians } from './family.ts';
import { clearRestrictions, setRestrictions } from './restrictions.ts';
import type { Context } from './service.ts';
import { familyDashboardUrl } from './settings.ts';
import { releaseCurrentUsername } from './usernames.ts';

export const SAFETY_ENFORCEMENT_CONSUMER = 'safety_enforcement';

const ACTION_LABELS: Record<SafetyActionType, string> = {
  warn: 'Warn',
  restrict: 'Restrict',
  force_username_reset: 'Force username reset',
  lock: 'Lock',
  ban: 'Ban',
  remove_content: 'Remove content',
  proscribed_org_removal: 'Proscribed organisation removal',
};

const targetSchema = z.object({
  type: z.enum(['user', 'content']),
  id: z.string().min(1),
  user_id: z.uuid().nullable().optional(),
});

const actionedSchema = z.object({
  report_id: z.uuid(),
  action_id: z.uuid(),
  action: z.enum(SAFETY_ACTIONS),
  rule_id: z.string().min(1),
  target: targetSchema,
  restrictions: z.array(z.string().min(1)).optional(),
  expires_at: z.iso.datetime().nullable().optional(),
  reason_code: z.string().min(1).nullable().optional(),
});

const resolvedSchema = z.object({
  appeal_id: z.uuid(),
  action_id: z.uuid(),
  action: z.string().min(1),
  user_id: z.uuid(),
  outcome: z.enum(['lifted', 'upheld']),
  restrictions: z.array(z.string().min(1)).optional(),
});

function reasonOf(ruleId: string, reasonCode: string | null | undefined): string {
  return reasonCode ?? ruleId;
}

function targetUserId(target: z.infer<typeof targetSchema>): string | null {
  if (target.user_id) return target.user_id;
  if (target.type === 'user') return target.id;
  return null;
}

async function transition(
  trx: Kysely<Database>,
  options: {
    userId: string;
    from: AccountState;
    to: AccountState;
    now: Date;
    extra?: { locked_until: Date | null };
  },
): Promise<boolean> {
  const updated = await trx
    .updateTable('users')
    .set({
      state: options.to,
      updated_at: options.now,
      ...(options.extra ?? {}),
    })
    .where('id', '=', options.userId)
    .where('state', '=', options.from)
    .executeTakeFirst();
  return updatedRows(updated) > 0;
}

async function applyBan(
  trx: Kysely<Database>,
  options: {
    userId: string;
    actor: EventActor;
    reason: string;
    now: Date;
  },
): Promise<boolean> {
  const account = await findAccount(trx, options.userId);
  if (!account || account.state === 'deleted') return false;
  if (account.state === 'banned') return false;
  if (!canTransition(account.state, 'banned')) return false;
  const changed = await transition(trx, {
    userId: options.userId,
    from: account.state,
    to: 'banned',
    now: options.now,
    extra: { locked_until: null },
  });
  if (!changed) return false;
  await recordAccountAction(trx, {
    userId: options.userId,
    actor: options.actor,
    action: 'ban',
    reason: options.reason,
    fromState: account.state,
    toState: 'banned',
    expiresAt: null,
    now: options.now,
  });
  await writeEvent<Database, UserBannedData>(
    trx,
    userBannedEvent(account.id, { reason: options.reason }, options.actor),
  );
  return true;
}

async function applyUnban(
  trx: Kysely<Database>,
  options: {
    userId: string;
    actor: EventActor;
    reason: string;
    now: Date;
  },
): Promise<boolean> {
  const account = await findAccount(trx, options.userId);
  if (account?.state !== 'banned') return false;
  if (!canTransition(account.state, 'active')) return false;
  const changed = await transition(trx, {
    userId: options.userId,
    from: 'banned',
    to: 'active',
    now: options.now,
  });
  if (!changed) return false;
  await recordAccountAction(trx, {
    userId: options.userId,
    actor: options.actor,
    action: 'unban',
    reason: options.reason,
    fromState: 'banned',
    toState: 'active',
    expiresAt: null,
    now: options.now,
  });
  await writeEvent<Database, UserUnbannedData>(
    trx,
    userUnbannedEvent(account.id, { reason: options.reason }, options.actor),
  );
  return true;
}

async function applyLock(
  trx: Kysely<Database>,
  options: {
    userId: string;
    actor: EventActor;
    reason: string;
    expiresAt: Date;
    now: Date;
  },
): Promise<boolean> {
  if (options.expiresAt.getTime() <= options.now.getTime()) return false;
  const account = await findAccount(trx, options.userId);
  if (!account || account.state === 'deleted') return false;
  if (account.state !== 'locked' && !canTransition(account.state, 'locked')) return false;
  const changed = await transition(trx, {
    userId: options.userId,
    from: account.state,
    to: 'locked',
    now: options.now,
    extra: { locked_until: options.expiresAt },
  });
  if (!changed) return false;
  await recordAccountAction(trx, {
    userId: options.userId,
    actor: options.actor,
    action: 'lock',
    reason: options.reason,
    fromState: account.state,
    toState: 'locked',
    expiresAt: options.expiresAt,
    now: options.now,
  });
  await writeEvent<Database, UserLockedData>(
    trx,
    userLockedEvent(
      account.id,
      { reason: options.reason, expires_at: options.expiresAt.toISOString() },
      options.actor,
    ),
  );
  return true;
}

async function applyUnlock(
  trx: Kysely<Database>,
  options: {
    userId: string;
    actor: EventActor;
    reason: string;
    now: Date;
  },
): Promise<boolean> {
  const account = await findAccount(trx, options.userId);
  if (account?.state !== 'locked') return false;
  const changed = await transition(trx, {
    userId: options.userId,
    from: 'locked',
    to: 'active',
    now: options.now,
    extra: { locked_until: null },
  });
  if (!changed) return false;
  await recordAccountAction(trx, {
    userId: options.userId,
    actor: options.actor,
    action: 'unlock',
    reason: options.reason,
    fromState: 'locked',
    toState: 'active',
    expiresAt: null,
    now: options.now,
  });
  await writeEvent<Database, UserUnlockedData>(
    trx,
    userUnlockedEvent(account.id, { reason: options.reason }, options.actor),
  );
  return true;
}

async function applyUsernameReset(
  trx: Kysely<Database>,
  options: {
    userId: string;
    actor: EventActor;
    reason: string;
    now: Date;
  },
): Promise<boolean> {
  const account = await findAccount(trx, options.userId);
  if (!account || account.state === 'deleted') return false;
  const released = await releaseCurrentUsername(trx, {
    userId: options.userId,
    now: options.now,
  });
  if (!released) {
    await trx
      .updateTable('users')
      .set({ username_reset_required: true, updated_at: options.now })
      .where('id', '=', options.userId)
      .execute();
  }
  await recordAccountAction(trx, {
    userId: options.userId,
    actor: options.actor,
    action: 'force_username_reset',
    reason: options.reason,
    fromState: account.state,
    toState: account.state,
    expiresAt: null,
    now: options.now,
  });
  await writeEvent<Database, UserUpdatedData>(
    trx,
    userUpdatedEvent(options.userId, { fields: ['username'] }, options.actor),
  );
  return true;
}

async function notifyGuardians(
  ctx: Context,
  userId: string,
  action: SafetyActionType,
): Promise<void> {
  if (action === 'warn' || action === 'remove_content') return;
  const account = await findAccount(ctx.db, userId);
  if (!account || account.state === 'deleted') return;
  const guardians = await listActiveGuardians(ctx.db, userId);
  if (guardians.length === 0) return;
  const link = familyDashboardUrl(ctx.config);
  const username = childLabel(account.username);
  for (const guardian of guardians) {
    await queueEmail(ctx.bus, {
      template: 'guardian_moderation_action',
      to: { address: guardian.email },
      locale: account.locale ?? ctx.config.email.default_locale,
      userId: guardian.user_id,
      variables: { username, action: ACTION_LABELS[action], link },
    });
  }
}

async function applyActioned(
  trx: Kysely<Database>,
  event: EventEnvelope,
  now: Date,
): Promise<string | null> {
  const parsed = actionedSchema.safeParse(event.data);
  if (!parsed.success) return null;
  const data = parsed.data;
  const userId = targetUserId(data.target);
  if (userId === null) return null;
  const actor = event.actor;
  const reason = reasonOf(data.rule_id, data.reason_code);
  switch (data.action) {
    case 'warn':
    case 'remove_content':
      return null;
    case 'ban':
    case 'proscribed_org_removal':
      return (await applyBan(trx, { userId, actor, reason, now })) ? userId : null;
    case 'lock': {
      if (data.expires_at === undefined || data.expires_at === null) return null;
      const expiresAt = new Date(data.expires_at);
      return (await applyLock(trx, { userId, actor, reason, expiresAt, now })) ? userId : null;
    }
    case 'force_username_reset':
      return (await applyUsernameReset(trx, { userId, actor, reason, now })) ? userId : null;
    case 'restrict': {
      const names = data.restrictions ?? [];
      if (names.length === 0) return null;
      const expiresAt =
        data.expires_at === undefined || data.expires_at === null
          ? null
          : new Date(data.expires_at);
      await setRestrictions(trx, {
        userId,
        names,
        actionId: data.action_id,
        expiresAt,
        actor,
        reason,
        now,
      });
      await recordAccountAction(trx, {
        userId,
        actor,
        action: 'restrict',
        reason,
        fromState: null,
        toState: null,
        expiresAt,
        now,
      });
      return userId;
    }
  }
}

async function applyResolved(
  trx: Kysely<Database>,
  event: EventEnvelope,
  now: Date,
): Promise<void> {
  const parsed = resolvedSchema.safeParse(event.data);
  if (!parsed.success || parsed.data.outcome !== 'lifted') return;
  const data = parsed.data;
  const actor = event.actor;
  const reason = 'appeal';
  if (data.action === 'ban' || data.action === 'proscribed_org_removal') {
    await applyUnban(trx, { userId: data.user_id, actor, reason, now });
    return;
  }
  if (data.action === 'lock') {
    await applyUnlock(trx, { userId: data.user_id, actor, reason, now });
    return;
  }
  if (data.action === 'restrict') {
    await clearRestrictions(trx, {
      userId: data.user_id,
      actionId: data.action_id,
      actor,
      reason,
      now,
    });
    await recordAccountAction(trx, {
      userId: data.user_id,
      actor,
      action: 'unrestrict',
      reason,
      fromState: null,
      toState: null,
      expiresAt: null,
      now,
    });
  }
}

export async function handleSafetyEnforcement(
  ctx: Context,
  event: EventEnvelope,
  trx: Kysely<Database>,
): Promise<void> {
  const now = new Date();
  if (event.type === SAFETY_EVENTS.reportActioned || event.type === SAFETY_EVENTS.cseaEnforced) {
    const userId = await applyActioned(trx, event, now);
    if (userId !== null) {
      const parsed = actionedSchema.safeParse(event.data);
      if (parsed.success) await notifyGuardians(ctx, userId, parsed.data.action);
      ctx.outbox.wake();
    }
    return;
  }
  if (event.type === SAFETY_EVENTS.appealResolved) {
    await applyResolved(trx, event, now);
    ctx.outbox.wake();
  }
}
