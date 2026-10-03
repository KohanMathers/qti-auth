import type { Router } from '@qtiauth/service-kit';
import * as z from 'zod';

import { OPEN_ACCOUNT_STATES } from './accounts.ts';
import { completeBind, issueBindCode } from './bind.ts';
import { bindStoreOf } from './bind-state.ts';
import { sessionHeaders } from './headers.ts';
import { identityMetrics } from './metrics.ts';
import type { Context } from './service.ts';
import { signedIn } from './session-routes.ts';
import {
  BIND_CALLBACK_PAGE,
  BIND_PAGE,
  parseBindTarget,
  sessionClient,
  SIGN_IN_PAGE,
  surfaceForHost,
  surfaceOrigin,
  surfacePath,
  surfaceUrl,
} from './settings.ts';

const redirects = { 302: { description: 'Redirect' } };

function redirect(location: string, headers: Record<string, string> = {}): Response {
  return new Response(null, { status: 302, headers: { ...headers, location } });
}

function bindFailed(ctx: Context): Response {
  return redirect(surfaceUrl(ctx.config, 'account', SIGN_IN_PAGE) ?? SIGN_IN_PAGE);
}

export function bindRoutes(router: Router<Context>): void {
  router.route({
    method: 'GET',
    path: BIND_PAGE,
    operation_id: 'bindSession',
    summary: 'Issue a one-time code that binds this session to another surface',
    description:
      'The gateway sends a browser here when a surface on another host has no session cookie. Redirects to that surface’s bind callback, or to sign-in when the request cannot be bound.',
    tags: ['auth'],
    auth: 'session',
    allow_account_states: OPEN_ACCOUNT_STATES,
    allow_pending_legal: true,
    allow_pending_parental_consent: true,
    allow_pending_2fa_enrolment: true,
    rate_limit: 'global',
    request: {
      query: z.object({
        target: z.string().max(32).optional(),
        return: z.string().max(2048).optional(),
      }),
    },
    responses: redirects,
    errors: ['ACCOUNT_NOT_FOUND'],
    handler: async ({ ctx, identity, query, log }) => {
      const { sessionId } = signedIn(identity);
      const target = parseBindTarget(ctx.config, query.target ?? '', query.return ?? '');
      const store = bindStoreOf(ctx);
      if (target === undefined || store === undefined) return bindFailed(ctx);
      const issued = await issueBindCode(store, {
        sessionId,
        target: target.target,
        origin: target.origin,
        returnPath: target.returnPath,
      });
      const callback = new URL(
        surfacePath(ctx.config, target.target, BIND_CALLBACK_PAGE),
        target.origin,
      );
      callback.searchParams.set('code', issued.code);
      log.info('session bind started', { target: target.target, session_id: sessionId });
      return redirect(callback.toString(), { 'cache-control': 'no-store' });
    },
  });

  router.route({
    method: 'GET',
    path: BIND_CALLBACK_PAGE,
    operation_id: 'bindSessionCallback',
    summary: 'Exchange a bind code for a session cookie on this surface',
    tags: ['auth'],
    auth: 'none',
    rate_limit: 'auth_verify',
    request: { query: z.object({ code: z.string().max(256).optional() }) },
    responses: redirects,
    handler: async ({ ctx, query, request, log }) => {
      const store = bindStoreOf(ctx);
      const host = request.headers.get('x-forwarded-host') ?? '';
      const target = surfaceForHost(ctx.config, host);
      const origin = target === undefined ? undefined : surfaceOrigin(ctx.config, target);
      if (
        store === undefined ||
        query.code === undefined ||
        target === undefined ||
        origin === undefined
      ) {
        return bindFailed(ctx);
      }
      const cookieScope = sessionClient(ctx.config, request).cookieScope;
      const result = await completeBind(ctx.db, store, {
        code: query.code,
        target,
        origin,
        cookieScope,
        idleTimeout: ctx.config.cookies.idle_timeout,
        now: new Date(),
      });
      if (result.status !== 'ok') return bindFailed(ctx);
      identityMetrics(ctx.metrics).bindingCreated();
      log.info('session bound', { target, cookie_scope: cookieScope });
      return redirect(
        result.returnPath,
        sessionHeaders({
          id: result.sessionId,
          token: result.token,
          expiresAt: result.expiresAt,
          evicted: [],
        }),
      );
    },
  });
}
