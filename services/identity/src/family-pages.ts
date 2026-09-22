import { FAMILY_TOKEN_HEADER, type Router } from '@qtiauth/service-kit';
import * as z from 'zod';

import { findAccount, SIGNED_IN_STATES } from './accounts.ts';
import { isValidDateOfBirth } from './age.ts';
import { parseDevice } from './device.ts';
import {
  acceptGuardianInvite,
  actorManagesChild,
  createFamilySession,
  decideUsernameChange,
  DEFAULT_PARENTAL_CONTROLS,
  familyEventActor,
  hasActiveGuardians,
  inviteGuardian,
  issueFamilyAccess,
  listFamilyChildren,
  listGuardians,
  loadParentalControls,
  pendingUsernameChange,
  resolveFamilyActor,
  revokeFamilySession,
  revokeGuardian,
  updateChildControls,
  type FamilyActor,
} from './family.ts';
import { decideChildAppApproval, familyChildActivity, pendingAppApprovals } from './family-apps.ts';
import { applyFilter } from './filter.ts';
import {
  sendFamilyAccessEmail,
  sendFamilyInviteEmail,
  sendGuardianRemovalRequestEmail,
  sendGuardianRemovedEmail,
  startDataExport,
} from './flows.ts';
import {
  cancelGuardianRemoval,
  decideGuardianRemoval,
  guardianRemovalMode,
  pendingGuardianRemoval,
  requestGuardianRemoval,
} from './graduation.ts';
import { familyHeaders, familySignedOutHeaders, revokedHeaders } from './headers.ts';
import { escapeHtml, hiddenInput, type HtmlPage, htmlResponse } from './html.ts';
import { acceptLegalAsGuardian, pendingMaterialVersions } from './legal.ts';
import { requestDeletion } from './lifecycle.ts';
import { identityMetrics } from './metrics.ts';
import type { Context } from './service.ts';
import { signedIn } from './session-routes.ts';
import { listSessions, revokeSessions } from './sessions.ts';
import {
  FAMILY_CHILD_PAGE,
  FAMILY_INVITE_PAGE,
  FAMILY_LEAVE_PAGE,
  FAMILY_MAGIC_LINK_PAGE,
  FAMILY_PAGE,
  FAMILY_SESSION_PAGE,
  clientIp,
  parentalSettings,
} from './settings.ts';

const htmlResponses = { 200: { description: 'An HTML page' } };

type Page = Omit<HtmlPage, 'product'>;

const FORM_CONTENT_TYPE = /^application\/x-www-form-urlencoded\s*(?:;|$)/i;

async function readForm(request: Request): Promise<Record<string, string>> {
  if (!FORM_CONTENT_TYPE.test(request.headers.get('content-type') ?? '')) return {};
  return Object.fromEntries(new URLSearchParams(await request.text()));
}

function page(ctx: Context, content: Page): Response {
  return htmlResponse({ ...content, product: ctx.config.branding.product_name });
}

function paragraph(text: string): string {
  return `<p>${escapeHtml(text)}</p>`;
}

function alert(text: string): string {
  return `<p role="alert">${escapeHtml(text)}</p>`;
}

function familySessionNeeded(ctx: Context): Response {
  return page(ctx, {
    status: 401,
    title: 'Family dashboard',
    body: `${paragraph('Open the family dashboard from the emailed link, or sign in with the parent or guardian account.')}
<p><a href="${escapeHtml(FAMILY_MAGIC_LINK_PAGE)}">Email a link</a></p>`,
  });
}

function familyChildMissing(ctx: Context): Response {
  return page(ctx, {
    status: 404,
    title: 'Child account not found',
    body: `${paragraph('This account is not one you can manage.')}
<p><a href="${escapeHtml(FAMILY_PAGE)}">Family dashboard</a></p>`,
  });
}

async function actorOf(
  ctx: Context,
  request: Request,
  identity: { sid: string | null },
): Promise<FamilyActor | undefined> {
  return resolveFamilyActor(ctx.db, {
    familyToken: request.headers.get(FAMILY_TOKEN_HEADER),
    sessionId: identity.sid,
    idleTimeout: ctx.config.cookies.idle_timeout,
    now: new Date(),
  });
}

function checkbox(name: string, label: string, checked: boolean): string {
  return `<p><label><input type="checkbox" name="${escapeHtml(name)}" value="1"${checked ? ' checked' : ''}> ${escapeHtml(label)}</label></p>`;
}

async function familyLeavePage(ctx: Context, userId: string, message?: string): Promise<Response> {
  const account = await findAccount(ctx.db, userId);
  if (!account) {
    return page(ctx, {
      status: 404,
      title: 'Account not found',
      body: paragraph('This account does not exist.'),
    });
  }
  const linked = await hasActiveGuardians(ctx.db, userId);
  if (!linked) {
    return page(ctx, {
      title: 'Parent or guardian link',
      body: `${message === undefined ? '' : alert(message)}
${paragraph('This account has no parent or guardian link.')}`,
    });
  }
  const pending = await pendingGuardianRemoval(ctx.db, userId);
  if (pending !== undefined) {
    return page(ctx, {
      title: 'Waiting for approval',
      body: `${message === undefined ? '' : alert(message)}
${paragraph('A parent or guardian needs to approve removing this link.')}
<form method="post" action="leave">
<p><button type="submit" name="action" value="cancel">Cancel request</button></p>
</form>`,
    });
  }
  const mode = guardianRemovalMode(account.date_of_birth, {
    consentAge: ctx.config.parental.consent_age,
    adultAge: ctx.config.age.bands.adult,
    graceMs: ctx.config.parental.graduation_grace,
    now: new Date(),
  });
  if (mode === 'blocked') {
    return page(ctx, {
      title: 'Parent or guardian link',
      body: `${message === undefined ? '' : alert(message)}
${paragraph('The parent or guardian link cannot be removed yet.')}`,
    });
  }
  return page(ctx, {
    title: 'Parent or guardian link',
    body: `${message === undefined ? '' : alert(message)}
${paragraph(
  mode === 'self'
    ? 'You can remove the parent or guardian link without approval.'
    : 'A parent or guardian must approve removing this link.',
)}
<form method="post" action="leave">
<p><button type="submit">Remove the parent or guardian link</button></p>
</form>`,
  });
}

export function familyPageRoutes(router: Router<Context>): void {
  router.route({
    method: 'GET',
    path: FAMILY_LEAVE_PAGE,
    operation_id: 'familyLeavePage',
    summary: 'Ask to remove the parent or guardian link',
    tags: ['pages'],
    auth: 'session',
    allow_account_states: SIGNED_IN_STATES,
    rate_limit: 'global',
    responses: htmlResponses,
    handler: async ({ ctx, identity }) => {
      const { userId } = signedIn(identity);
      return familyLeavePage(ctx, userId);
    },
  });

  router.route({
    method: 'POST',
    path: FAMILY_LEAVE_PAGE,
    operation_id: 'familyLeavePageSubmit',
    summary: 'Submit a request to remove the parent or guardian link',
    tags: ['pages'],
    auth: 'session',
    allow_account_states: SIGNED_IN_STATES,
    rate_limit: 'global',
    responses: htmlResponses,
    handler: async ({ ctx, identity, request, log }) => {
      const { userId } = signedIn(identity);
      const account = await findAccount(ctx.db, userId);
      if (!account) {
        return page(ctx, {
          status: 404,
          title: 'Account not found',
          body: paragraph('This account does not exist.'),
        });
      }
      const form = await readForm(request);
      if (form['action'] === 'cancel') {
        const result = await cancelGuardianRemoval(ctx.db, { userId, now: new Date() });
        if (result.status !== 'ok') {
          return familyLeavePage(ctx, userId, 'There is no request waiting.');
        }
        log.info('guardian removal cancelled', { user_id: userId });
        return familyLeavePage(ctx, userId, 'The request has been cancelled.');
      }
      const result = await requestGuardianRemoval(ctx.db, {
        userId,
        dateOfBirth: account.date_of_birth,
        bands: ctx.config.age.bands,
        consentAge: ctx.config.parental.consent_age,
        graceMs: ctx.config.parental.graduation_grace,
        now: new Date(),
      });
      if (result.status === 'none') {
        return familyLeavePage(ctx, userId, 'This account has no parent or guardian link.');
      }
      if (result.status === 'blocked') {
        return familyLeavePage(ctx, userId, 'The parent or guardian link cannot be removed yet.');
      }
      if (result.status === 'already_pending') {
        return familyLeavePage(ctx, userId, 'A request is already waiting for approval.');
      }
      if (result.status === 'pending') {
        await sendGuardianRemovalRequestEmail(ctx, {
          childUserId: userId,
          username: account.username,
          locale: account.locale,
        });
        ctx.outbox.wake();
        identityMetrics(ctx.metrics).graduation('removal_requested');
        log.info('guardian removal requested', { user_id: userId });
        return familyLeavePage(ctx, userId, 'A parent or guardian needs to approve this request.');
      }
      await sendGuardianRemovedEmail(ctx, {
        username: account.username,
        locale: account.locale,
        guardians: result.guardians,
      });
      ctx.outbox.wake();
      identityMetrics(ctx.metrics).graduation('removed');
      log.info('guardian link removed', { user_id: userId });
      return page(ctx, {
        title: 'Parent or guardian link removed',
        body: paragraph('The parent or guardian link has been removed.'),
      });
    },
  });

  router.route({
    method: 'GET',
    path: FAMILY_MAGIC_LINK_PAGE,
    operation_id: 'familyMagicLinkPage',
    summary: 'Ask for a family dashboard link',
    tags: ['pages'],
    auth: 'none',
    rate_limit: 'global',
    responses: htmlResponses,
    handler: ({ ctx }) =>
      Promise.resolve(
        page(ctx, {
          title: 'Family dashboard',
          body: `${paragraph('Enter the email used as a parent or guardian. If it matches, we will send a link.')}
<form method="post" action="magic-link">
<p><label for="email">Email</label><br>
<input id="email" name="email" type="email" autocomplete="email" required></p>
<p><button type="submit">Email me a link</button></p>
</form>`,
        }),
      ),
  });

  router.route({
    method: 'POST',
    path: FAMILY_MAGIC_LINK_PAGE,
    operation_id: 'familyMagicLinkPageSubmit',
    summary: 'Send a family dashboard link from the form',
    tags: ['pages'],
    auth: 'none',
    rate_limit: 'magic_link',
    responses: htmlResponses,
    handler: async ({ ctx, request, log }) => {
      const email = (await readForm(request))['email'] ?? '';
      const issued = await issueFamilyAccess(ctx.db, {
        email,
        normalizeEmail: parentalSettings(ctx.config).normalizeEmail,
        ttl: ctx.config.magic_link.ttl,
        now: new Date(),
      });
      if (issued) {
        await sendFamilyAccessEmail(ctx, issued);
        ctx.outbox.wake();
        log.info('family access email sent');
      } else {
        log.info('family access email skipped');
      }
      return page(ctx, {
        status: 202,
        title: 'Check your email',
        body: paragraph('If this address is a parent or guardian, a link is on its way.'),
      });
    },
  });

  router.route({
    method: 'GET',
    path: FAMILY_SESSION_PAGE,
    operation_id: 'familySessionPage',
    summary: 'Open a family dashboard session from an emailed link',
    tags: ['pages'],
    auth: 'none',
    rate_limit: 'global',
    request: { query: z.object({ token: z.string().max(256).optional() }) },
    responses: htmlResponses,
    handler: ({ ctx, query }) => {
      if (query.token === undefined) {
        return Promise.resolve(
          page(ctx, {
            status: 400,
            title: 'This link can’t be used',
            body: paragraph('Ask for a new family dashboard link.'),
          }),
        );
      }
      return Promise.resolve(
        page(ctx, {
          title: 'Open the family dashboard',
          body: `<form method="post" action="session">
${hiddenInput('token', query.token)}
<p><button type="submit">Continue</button></p>
</form>`,
        }),
      );
    },
  });

  router.route({
    method: 'POST',
    path: FAMILY_SESSION_PAGE,
    operation_id: 'familySessionPageSubmit',
    summary: 'Start a family dashboard session from the emailed link',
    tags: ['pages'],
    auth: 'none',
    rate_limit: 'auth_verify',
    responses: htmlResponses,
    handler: async ({ ctx, request, log }) => {
      const token = (await readForm(request))['token'] ?? '';
      const session = await createFamilySession(ctx.db, {
        token,
        sessionTtl: ctx.config.cookies.session_ttl,
        now: new Date(),
      });
      if (!session) {
        return page(ctx, {
          status: 400,
          title: 'This link can’t be used',
          body: paragraph('It has expired or has already been used. Ask for a new link.'),
        });
      }
      identityMetrics(ctx.metrics).familySession();
      log.info('family session started');
      return new Response(null, {
        status: 303,
        headers: {
          ...familyHeaders(session),
          location: FAMILY_PAGE,
        },
      });
    },
  });

  router.route({
    method: 'GET',
    path: FAMILY_INVITE_PAGE,
    operation_id: 'familyInvitePage',
    summary: 'Accept an invitation to become a parent or guardian',
    tags: ['pages'],
    auth: 'none',
    rate_limit: 'global',
    request: { query: z.object({ token: z.string().max(256).optional() }) },
    responses: htmlResponses,
    handler: ({ ctx, query }) => {
      if (query.token === undefined) {
        return Promise.resolve(
          page(ctx, {
            status: 400,
            title: 'This link can’t be used',
            body: paragraph('Ask for a new invitation.'),
          }),
        );
      }
      return Promise.resolve(inviteForm(ctx, query.token));
    },
  });

  router.route({
    method: 'POST',
    path: FAMILY_INVITE_PAGE,
    operation_id: 'familyInvitePageSubmit',
    summary: 'Accept a parent or guardian invitation from the form',
    tags: ['pages'],
    auth: 'none',
    rate_limit: 'auth_verify',
    responses: htmlResponses,
    handler: async ({ ctx, request, log }) => {
      const form = await readForm(request);
      const token = form['token'] ?? '';
      const dateOfBirth = form['date_of_birth'] ?? '';
      if (!isValidDateOfBirth(dateOfBirth, new Date())) {
        return inviteForm(ctx, token, 'Enter your real date of birth.');
      }
      const result = await acceptGuardianInvite(ctx.db, {
        token,
        dateOfBirth,
        bands: ctx.config.age.bands,
        maxGuardians: ctx.config.parental.max_guardians,
        now: new Date(),
      });
      if (result.status === 'not_adult') {
        return inviteForm(
          ctx,
          token,
          `You need to be at least ${String(ctx.config.age.bands.adult)} to become a parent or guardian.`,
        );
      }
      if (result.status === 'limit') {
        return page(ctx, {
          status: 409,
          title: 'This account already has enough parents or guardians',
          body: paragraph('The invitation cannot be accepted.'),
        });
      }
      if (result.status !== 'ok') {
        return page(ctx, {
          status: 400,
          title: 'This link can’t be used',
          body: paragraph('It has expired or has already been used.'),
        });
      }
      ctx.outbox.wake();
      log.info('family invite accepted', { user_id: result.childUserId });
      return page(ctx, {
        title: 'You are now a parent or guardian',
        body: `${paragraph('You can open the family dashboard from a magic link sent to this email.')}
<p><a href="${escapeHtml(FAMILY_MAGIC_LINK_PAGE)}">Email me a dashboard link</a></p>`,
      });
    },
  });

  router.route({
    method: 'POST',
    path: `${FAMILY_PAGE}/logout`,
    operation_id: 'familyLogoutPage',
    summary: 'End the family dashboard session from the form',
    tags: ['pages'],
    auth: 'none',
    rate_limit: 'global',
    responses: htmlResponses,
    handler: async ({ ctx, request }) => {
      const token = request.headers.get(FAMILY_TOKEN_HEADER);
      if (token !== null) await revokeFamilySession(ctx.db, { token, now: new Date() });
      return page(ctx, {
        title: 'Family dashboard signed out',
        headers: familySignedOutHeaders(),
        body: `${paragraph('The family dashboard session has ended.')}
<p><a href="${escapeHtml(FAMILY_MAGIC_LINK_PAGE)}">Email a new link</a></p>`,
      });
    },
  });

  router.route({
    method: 'GET',
    path: FAMILY_PAGE,
    operation_id: 'familyDashboardPage',
    summary: 'List child accounts this parent or guardian can manage',
    tags: ['pages'],
    auth: 'none',
    rate_limit: 'global',
    responses: htmlResponses,
    handler: async ({ ctx, request, identity }) => {
      const actor = await actorOf(ctx, request, identity);
      if (!actor) return familySessionNeeded(ctx);
      const children = await listFamilyChildren(ctx.db, actor, ctx.config.age.bands, new Date());
      const items =
        children.length === 0
          ? paragraph('There are no child accounts on this family dashboard.')
          : `<ul>${children
              .map(
                (child) =>
                  `<li><a href="${escapeHtml(`/family/${child.id}`)}">${escapeHtml(child.username ?? 'this child')}</a></li>`,
              )
              .join('')}</ul>`;
      return page(ctx, {
        title: 'Family dashboard',
        body: `${items}
<form method="post" action="${escapeHtml(`${FAMILY_PAGE}/logout`)}"><button type="submit">End family session</button></form>`,
      });
    },
  });

  router.route({
    method: 'GET',
    path: FAMILY_CHILD_PAGE,
    operation_id: 'familyChildPage',
    summary: 'Manage a child account from the family dashboard',
    tags: ['pages'],
    auth: 'none',
    rate_limit: 'global',
    request: { params: z.object({ child_id: z.uuid() }) },
    responses: htmlResponses,
    handler: async ({ ctx, request, identity, params }) => {
      const actor = await actorOf(ctx, request, identity);
      if (!actor) return familySessionNeeded(ctx);
      return childDashboard(ctx, actor, params.child_id);
    },
  });

  router.route({
    method: 'POST',
    path: FAMILY_CHILD_PAGE,
    operation_id: 'familyChildPageSubmit',
    summary: 'Change a child account from the family dashboard form',
    tags: ['pages'],
    auth: 'none',
    rate_limit: 'global',
    request: { params: z.object({ child_id: z.uuid() }) },
    responses: htmlResponses,
    handler: async ({ ctx, request, identity, params, log }) => {
      const actor = await actorOf(ctx, request, identity);
      if (!actor) return familySessionNeeded(ctx);
      const guardian = await actorManagesChild(ctx.db, actor, params.child_id);
      const account = guardian ? await findAccount(ctx.db, params.child_id) : undefined;
      if (!guardian || !account || account.state === 'deleted') return familyChildMissing(ctx);
      const form = await readForm(request);
      const action = form['action'] ?? '';
      const now = new Date();
      const eventActor = familyEventActor(actor);
      const playtimeMinutes = Number.parseInt(form['daily_playtime_minutes'] ?? '', 10);
      switch (action) {
        case 'controls': {
          await updateChildControls(ctx.db, {
            childUserId: account.id,
            actor: eventActor,
            controls: {
              online_play: form['online_play'] === '1',
              in_game_chat: form['in_game_chat'] === '1',
              user_generated_content: form['user_generated_content'] === '1',
              purchases: form['purchases'] === '1',
              daily_playtime_minutes: Number.isFinite(playtimeMinutes) ? playtimeMinutes : null,
              public_profile: form['public_profile'] === '1',
              leaderboard_visible: form['leaderboard_visible'] === '1',
            },
            now,
          });
          ctx.outbox.wake();
          log.info('family controls updated', { user_id: account.id });
          return childDashboard(ctx, actor, account.id, 'Controls saved.');
        }
        case 'revoke_session': {
          const sessionId = form['session_id'] ?? '';
          const revoked = await ctx.db.transaction().execute((trx) =>
            revokeSessions(trx, {
              userId: account.id,
              reason: 'revoked',
              only: [sessionId],
              now,
            }),
          );
          if (revoked.length === 0) {
            return childDashboard(ctx, actor, account.id, 'That session is no longer active.');
          }
          ctx.outbox.wake();
          identityMetrics(ctx.metrics).sessionsRevoked('revoked', revoked.length);
          log.info('child session revoked', { session_id: sessionId, user_id: account.id });
          return page(ctx, {
            title: 'Session ended',
            headers: revokedHeaders(revoked),
            body: `${paragraph('That session has ended.')}
<p><a href="${escapeHtml(`/family/${account.id}`)}">Back</a></p>`,
          });
        }
        case 'revoke_all_sessions': {
          const revoked = await ctx.db
            .transaction()
            .execute((trx) => revokeSessions(trx, { userId: account.id, reason: 'revoked', now }));
          ctx.outbox.wake();
          identityMetrics(ctx.metrics).sessionsRevoked('revoked', revoked.length);
          log.info('child sessions revoked', { user_id: account.id, revoked: revoked.length });
          return page(ctx, {
            title: 'Sessions ended',
            headers: revokedHeaders(revoked),
            body: `${paragraph('Every session on this account has ended.')}
<p><a href="${escapeHtml(`/family/${account.id}`)}">Back</a></p>`,
          });
        }
        case 'approve_username':
        case 'decline_username': {
          const result = await decideUsernameChange(ctx.db, {
            childUserId: account.id,
            requestId: form['request_id'] ?? '',
            approve: action === 'approve_username',
            settings: ctx.config.usernames,
            isBlocked: async (username) =>
              (await applyFilter(ctx, username, 'username')).decision === 'block',
            actor: eventActor,
            now,
          });
          if (result.status === 'not_found') {
            return childDashboard(
              ctx,
              actor,
              account.id,
              'That username change is no longer waiting.',
            );
          }
          if (result.status !== 'ok') {
            return childDashboard(ctx, actor, account.id, 'That username cannot be used.');
          }
          ctx.outbox.wake();
          if (action === 'approve_username') identityMetrics(ctx.metrics).username('change');
          log.info(
            action === 'approve_username'
              ? 'child username change approved'
              : 'child username change declined',
            { user_id: account.id },
          );
          return childDashboard(
            ctx,
            actor,
            account.id,
            action === 'approve_username' ? 'Username saved.' : 'Username change declined.',
          );
        }
        case 'approve_app':
        case 'decline_app': {
          const status = await decideChildAppApproval(ctx, {
            childUserId: account.id,
            requestId: form['request_id'] ?? '',
            approve: action === 'approve_app',
            actor: eventActor,
          });
          if (status === 'not_found') {
            return childDashboard(ctx, actor, account.id, 'That app request is no longer waiting.');
          }
          log.info(action === 'approve_app' ? 'child app approved' : 'child app declined', {
            user_id: account.id,
          });
          return childDashboard(
            ctx,
            actor,
            account.id,
            action === 'approve_app' ? 'App approved.' : 'App declined.',
          );
        }
        case 'accept_legal': {
          const pending = await pendingMaterialVersions(ctx.db, account.id, now);
          if (pending.length === 0) {
            return childDashboard(ctx, actor, account.id, 'There are no documents waiting.');
          }
          const result = await acceptLegalAsGuardian(ctx.db, {
            childUserId: account.id,
            documents: pending.map((document) => ({ id: document.id, version: document.version })),
            ip: clientIp(request) || null,
            actor: eventActor,
            now,
          });
          if (result.status !== 'ok') {
            return childDashboard(ctx, actor, account.id, 'Those documents could not be accepted.');
          }
          ctx.outbox.wake();
          log.info('child legal accepted', { user_id: account.id, accepted: result.accepted });
          return childDashboard(ctx, actor, account.id, 'Documents accepted.');
        }
        case 'export': {
          const result = await startDataExport({ ctx, request, log }, { userId: account.id });
          if (result.status === 'not_found') return familyChildMissing(ctx);
          return page(ctx, {
            status: 202,
            title: 'Export started',
            body: paragraph('We will email a copy of this child’s data when it is ready.'),
          });
        }
        case 'deletion': {
          const result = await requestDeletion(ctx.db, {
            userId: account.id,
            actor: eventActor,
            now,
          });
          if (result.status === 'not_found') return familyChildMissing(ctx);
          if (result.status === 'conflict') {
            return childDashboard(ctx, actor, account.id, 'This account cannot be deleted.');
          }
          ctx.outbox.wake();
          identityMetrics(ctx.metrics).deletion('requested');
          identityMetrics(ctx.metrics).sessionsRevoked('revoked', result.revoked.length);
          log.info('child account deletion requested', { user_id: account.id });
          return page(ctx, {
            title: 'Deletion scheduled',
            headers: revokedHeaders(result.revoked),
            body: `${paragraph('This account is scheduled for deletion.')}
<p><a href="${escapeHtml(FAMILY_PAGE)}">Family dashboard</a></p>`,
          });
        }
        case 'invite': {
          const result = await inviteGuardian(ctx.db, {
            childUserId: account.id,
            childNormalized: parentalSettings(ctx.config).normalizeEmail(account.email),
            email: form['email'] ?? '',
            displayName: form['display_name'] ?? null,
            invitedBy: guardian.id,
            actor: eventActor,
            locale: actor.locale,
            settings: {
              maxGuardians: ctx.config.parental.max_guardians,
              normalizeEmail: parentalSettings(ctx.config).normalizeEmail,
            },
            isBlocked: async (name) =>
              (await applyFilter(ctx, name, 'guardian_display_name')).decision === 'block',
            ttl: ctx.config.magic_link.ttl,
            now,
          });
          switch (result.status) {
            case 'invalid':
            case 'same_as_child':
              return childDashboard(ctx, actor, account.id, 'That email cannot be used.');
            case 'blocked':
              return childDashboard(ctx, actor, account.id, 'That display name cannot be used.');
            case 'duplicate':
              return childDashboard(
                ctx,
                actor,
                account.id,
                'That parent or guardian is already linked.',
              );
            case 'limit':
              return childDashboard(
                ctx,
                actor,
                account.id,
                'This account already has the maximum number of parents or guardians.',
              );
            case 'ok':
              await sendFamilyInviteEmail(ctx, result);
              ctx.outbox.wake();
              log.info('family guardian invited', { user_id: account.id });
              return childDashboard(ctx, actor, account.id, 'An invitation is on its way.');
          }
          break;
        }
        case 'revoke_guardian': {
          const result = await revokeGuardian(ctx.db, {
            childUserId: account.id,
            guardianId: form['guardian_id'] ?? '',
            actor: eventActor,
            now,
          });
          if (result.status === 'not_found') {
            return childDashboard(
              ctx,
              actor,
              account.id,
              'That parent or guardian is not on this account.',
            );
          }
          if (result.status === 'last') {
            return childDashboard(
              ctx,
              actor,
              account.id,
              'The last parent or guardian cannot be removed.',
            );
          }
          ctx.outbox.wake();
          log.info('family guardian revoked', { user_id: account.id });
          return childDashboard(ctx, actor, account.id, 'Parent or guardian removed.');
        }
        case 'approve_removal':
        case 'decline_removal': {
          const result = await decideGuardianRemoval(ctx.db, {
            childUserId: account.id,
            approve: action === 'approve_removal',
            actor: eventActor,
            now,
          });
          if (result.status === 'not_found') {
            return childDashboard(ctx, actor, account.id, 'That request is no longer waiting.');
          }
          if (action === 'approve_removal') {
            await sendGuardianRemovedEmail(ctx, {
              username: account.username,
              locale: account.locale,
              guardians: result.guardians ?? [],
            });
            ctx.outbox.wake();
            identityMetrics(ctx.metrics).graduation('removed');
            log.info('guardian removal approved', { user_id: account.id });
            return page(ctx, {
              title: 'Parent or guardian link removed',
              body: `${paragraph('The parent or guardian link has been removed.')}
<p><a href="${escapeHtml(FAMILY_PAGE)}">Family dashboard</a></p>`,
            });
          }
          ctx.outbox.wake();
          log.info('guardian removal declined', { user_id: account.id });
          return childDashboard(ctx, actor, account.id, 'The request was declined.');
        }
        default:
          return childDashboard(ctx, actor, account.id);
      }
    },
  });
}

function inviteForm(ctx: Context, token: string, error?: string): Response {
  return page(ctx, {
    status: error === undefined ? 200 : 400,
    title: 'Become a parent or guardian',
    body: `${error === undefined ? '' : alert(error)}
${paragraph('Confirm you are an adult to join this family dashboard.')}
<form method="post" action="invite">
${hiddenInput('token', token)}
<p><label for="date_of_birth">Your date of birth</label><br>
<input id="date_of_birth" name="date_of_birth" type="date" required></p>
<p><button type="submit">Accept</button></p>
</form>`,
  });
}

async function childDashboard(
  ctx: Context,
  actor: FamilyActor,
  childId: string,
  message?: string,
): Promise<Response> {
  const guardian = await actorManagesChild(ctx.db, actor, childId);
  const account = guardian ? await findAccount(ctx.db, childId) : undefined;
  if (!guardian || !account || account.state === 'deleted') return familyChildMissing(ctx);
  const now = new Date();
  const [
    controls,
    pendingChange,
    pendingApps,
    pendingRemoval,
    pendingLegal,
    activity,
    guardians,
    sessions,
  ] = await Promise.all([
    loadParentalControls(ctx.db, account.id),
    pendingUsernameChange(ctx.db, account.id),
    pendingAppApprovals(ctx.bus, account.id),
    pendingGuardianRemoval(ctx.db, account.id),
    pendingMaterialVersions(ctx.db, account.id, now),
    familyChildActivity(ctx, { childUserId: account.id, now }),
    listGuardians(ctx.db, account.id),
    listSessions(ctx.db, {
      userId: account.id,
      idleTimeout: ctx.config.cookies.idle_timeout,
      now,
      after: undefined,
      limit: 100,
    }),
  ]);
  const current = {
    ...(controls ?? DEFAULT_PARENTAL_CONTROLS),
    public_profile: account.public_profile,
    leaderboard_visible: account.leaderboard_visible,
  };
  const playtime =
    current.daily_playtime_minutes === null ? '' : String(current.daily_playtime_minutes);
  const sessionItems = sessions
    .map((row) => {
      const device = parseDevice(row.user_agent);
      return `<li>${escapeHtml(device.browser)} on ${escapeHtml(device.os)}
<form method="post" action="${escapeHtml(account.id)}">
${hiddenInput('action', 'revoke_session')}
${hiddenInput('session_id', row.id)}
<button type="submit">End this session</button>
</form>
</li>`;
    })
    .join('');
  const usernameBlock =
    pendingChange === undefined
      ? ''
      : `${paragraph(`Waiting to change the username to ${pendingChange.username}.`)}
<form method="post" action="${escapeHtml(account.id)}">
${hiddenInput('request_id', pendingChange.id)}
<p><button type="submit" name="action" value="approve_username">Approve username</button>
<button type="submit" name="action" value="decline_username">Decline</button></p>
</form>`;
  const appItems = pendingApps
    .map(
      (app) =>
        `<li>${escapeHtml(app.name)}
<form method="post" action="${escapeHtml(account.id)}">
${hiddenInput('request_id', app.id)}
<p><button type="submit" name="action" value="approve_app">Approve app</button>
<button type="submit" name="action" value="decline_app">Decline</button></p>
</form>
</li>`,
    )
    .join('');
  const connected =
    activity.connected_apps.length === 0
      ? 'None this week'
      : activity.connected_apps.map((app) => app.name).join(', ');
  const removalBlock =
    pendingRemoval === undefined
      ? ''
      : `${paragraph('This young person asked to remove the parent or guardian link.')}
<form method="post" action="${escapeHtml(account.id)}">
<p><button type="submit" name="action" value="approve_removal">Approve removal</button>
<button type="submit" name="action" value="decline_removal">Decline</button></p>
</form>`;
  const legalBlock =
    pendingLegal.length === 0
      ? ''
      : `${paragraph('Legal documents are waiting for acceptance.')}
<ul>${pendingLegal.map((document) => `<li>${escapeHtml(document.id)} (${escapeHtml(document.version)})</li>`).join('')}</ul>
<form method="post" action="${escapeHtml(account.id)}">
${hiddenInput('action', 'accept_legal')}
<p><button type="submit">Accept on their behalf</button></p>
</form>`;
  const guardianItems = guardians
    .map(
      (row) =>
        `<li>${escapeHtml(row.email)}${row.status === 'pending' ? ' (invited)' : ''}
<form method="post" action="${escapeHtml(account.id)}">
${hiddenInput('action', 'revoke_guardian')}
${hiddenInput('guardian_id', row.id)}
<button type="submit">Remove</button>
</form>
</li>`,
    )
    .join('');
  return page(ctx, {
    title: account.username ?? 'Child account',
    body: `${message === undefined ? '' : alert(message)}
<p><a href="${escapeHtml(FAMILY_PAGE)}">All children</a></p>
${paragraph(`Sign-ins in the last seven days: ${String(activity.sign_ins)}. Connected apps: ${connected}.`)}
<h2>Apps waiting for approval</h2>
${appItems === '' ? paragraph('No apps are waiting.') : `<ul>${appItems}</ul>`}
<h2>Controls</h2>
<form method="post" action="${escapeHtml(account.id)}">
${hiddenInput('action', 'controls')}
${checkbox('online_play', 'Online play', current.online_play)}
${checkbox('in_game_chat', 'In-game chat', current.in_game_chat)}
${checkbox('user_generated_content', 'User-generated content', current.user_generated_content)}
${checkbox('purchases', 'Purchases', current.purchases)}
${checkbox('public_profile', 'Public profile', current.public_profile)}
${checkbox('leaderboard_visible', 'Show on leaderboards', current.leaderboard_visible)}
<p><label for="daily_playtime_minutes">Daily playtime (minutes, blank for no limit)</label><br>
<input id="daily_playtime_minutes" name="daily_playtime_minutes" type="number" min="0" value="${escapeHtml(playtime)}"></p>
<p><button type="submit">Save controls</button></p>
</form>
<h2>Username</h2>
${paragraph(`Current username: ${account.username ?? 'none yet'}.`)}
${usernameBlock}
${removalBlock}
<h2>Legal</h2>
${legalBlock || paragraph('No documents are waiting.')}
<h2>Sessions</h2>
${sessionItems === '' ? paragraph('No active sessions.') : `<ul>${sessionItems}</ul>`}
<form method="post" action="${escapeHtml(account.id)}">
${hiddenInput('action', 'revoke_all_sessions')}
<p><button type="submit">End every session</button></p>
</form>
<h2>Parents and guardians</h2>
<ul>${guardianItems}</ul>
<form method="post" action="${escapeHtml(account.id)}">
${hiddenInput('action', 'invite')}
<p><label for="email">Invite another parent or guardian</label><br>
<input id="email" name="email" type="email" required></p>
<p><label for="display_name">Display name (optional)</label><br>
<input id="display_name" name="display_name" maxlength="64"></p>
<p><button type="submit">Send invite</button></p>
</form>
<h2>Data rights</h2>
<form method="post" action="${escapeHtml(account.id)}">
<p><button type="submit" name="action" value="export">Request a data export</button></p>
<p><button type="submit" name="action" value="deletion">Delete this account</button></p>
</form>`,
  });
}
