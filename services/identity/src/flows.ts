import { queueEmail } from '@qtiauth/email';
import type { Logger } from '@qtiauth/observability';

import {
  completeSignup,
  issueMagicLink,
  MAGIC_LINK_METHOD,
  type SignupResult,
  verifyMagicLink,
  type VerifyResult,
} from './magic-links.ts';
import { identityMetrics } from './metrics.ts';
import type { Context } from './service.ts';
import { magicLinkSettings, magicLinkUrl, sessionClient } from './settings.ts';

export interface FlowInput {
  ctx: Context;
  request: Request;
  log: Logger;
}

export function magicLinkEnabled(ctx: Context): boolean {
  return ctx.config.features.auth.magic_link.enabled;
}

export async function sendMagicLink(
  { ctx, log }: FlowInput,
  input: { email: string; locale: string; returnTo: string | null },
): Promise<void> {
  const { token, expiresAt } = await issueMagicLink(ctx.db, {
    email: input.email,
    locale: input.locale,
    returnTo: input.returnTo,
    settings: magicLinkSettings(ctx.config),
    now: new Date(),
  });
  const job = await queueEmail(ctx.bus, {
    template: 'magic_link',
    to: { address: input.email.trim() },
    locale: input.locale,
    variables: {
      link: magicLinkUrl(ctx.config, token),
      expires_in_minutes: Math.ceil(ctx.config.magic_link.ttl / 60_000),
    },
  });
  identityMetrics(ctx.metrics).magicLink('sent');
  log.info('magic link sent', {
    delivery_id: job.delivery_id,
    expires_at: expiresAt.toISOString(),
  });
}

export async function verify(
  { ctx, request, log }: FlowInput,
  input: { token: string; userId: string | undefined },
): Promise<VerifyResult> {
  const metrics = identityMetrics(ctx.metrics);
  const result = await verifyMagicLink(ctx.db, {
    token: input.token,
    userId: input.userId,
    client: sessionClient(ctx.config, request),
    settings: magicLinkSettings(ctx.config),
    now: new Date(),
  });
  switch (result.status) {
    case 'invalid':
      metrics.magicLink(result.reason === 'expired' ? 'expired' : 'invalid');
      metrics.signIn(MAGIC_LINK_METHOD, 'failure');
      log.info('magic link rejected', { reason: result.reason });
      break;
    case 'choose_account':
      log.info('magic link matches several accounts', { accounts: result.accounts.length });
      break;
    case 'signup_required':
      metrics.magicLink('used');
      log.info('magic link opened for a new account');
      break;
    case 'signed_in':
      ctx.outbox.wake();
      metrics.magicLink('used');
      metrics.signIn(MAGIC_LINK_METHOD, 'success');
      metrics.sessionCreated(MAGIC_LINK_METHOD, result.session.evicted.length);
      log.info('signed in', {
        method: MAGIC_LINK_METHOD,
        user_id: result.userId,
        session_id: result.session.id,
        evicted_sessions: result.session.evicted.length,
      });
      break;
  }
  return result;
}

export async function signup(
  { ctx, request, log }: FlowInput,
  input: { signupToken: string; dateOfBirth: string },
): Promise<SignupResult> {
  const metrics = identityMetrics(ctx.metrics);
  const result = await completeSignup(ctx.db, {
    signupToken: input.signupToken,
    dateOfBirth: input.dateOfBirth,
    client: sessionClient(ctx.config, request),
    settings: magicLinkSettings(ctx.config),
    now: new Date(),
  });
  switch (result.status) {
    case 'invalid':
      log.info('signup token rejected', { reason: result.reason });
      break;
    case 'account_limit':
      log.info('signup refused: too many accounts with this email address');
      break;
    case 'parental_consent_required':
      log.info('signup refused: parental consent is not available');
      break;
    case 'signed_in':
      ctx.outbox.wake();
      metrics.signup(MAGIC_LINK_METHOD, result.ageBand);
      metrics.sessionCreated(MAGIC_LINK_METHOD, result.session.evicted.length);
      log.info('account created', {
        method: MAGIC_LINK_METHOD,
        user_id: result.userId,
        session_id: result.session.id,
        age_band: result.ageBand,
      });
      break;
  }
  return result;
}
