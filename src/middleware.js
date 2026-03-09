import { verify } from 'hono/jwt';

import { CONFIG } from './config.js';
import {
  collectFingerprint,
  hashToken,
  logSecurityEvent,
  now,
  sendSecurityAlert,
  validateSessionFingerprint,
} from './lib.js';

export const authMiddleware = async (c, next) => {
  try {
    const requestPath = new URL(c.req.url).pathname;
    const acceptHeader = c.req.header('accept') || '';
    const wantsHtml = acceptHeader.includes('text/html');
    const shouldRedirectToLogin = requestPath === '/oauth/authorize' && wantsHtml;

    // Only send a browser redirect for the OAuth authorize UI entrypoint.
    const maybeRedirectToLogin = () => {
      if (!shouldRedirectToLogin) return null;
      const frontendUrl = c.env.FRONTEND_URL || 'https://account.quietterminal.co.uk';
      const loginUrl = new URL(`${frontendUrl}/login`);
      loginUrl.searchParams.set('redirect', c.req.url);
      return c.redirect(loginUrl.toString());
    };

    const clearAuthCookie = () => {
      try {
        const domain = c.env.COOKIE_DOMAIN || '.quietterminal.co.uk';
        const cookie = `qti_token=deleted; Path=/; Domain=${domain}; HttpOnly; Secure; SameSite=None; Max-Age=0`;
        c.header('Set-Cookie', cookie);
      } catch (e) {
        console.error('Failed to clear cookie in auth middleware:', e);
      }
    };

    let token = c.req.header('Authorization')?.replace('Bearer ', '');
    if (!token) {
      const cookieHeader = c.req.header('cookie') || '';
      const match = cookieHeader.match(/(?:^|; )qti_token=([^;]+)/);
      if (match) token = match[1];
    }
    if (!token) {
      const redirect = maybeRedirectToLogin();
      if (redirect) return redirect;
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const db = c.env.DB;
    const currentTime = now();
    let payload;
    let authType = 'jwt';

    try {
      payload = await verify(token, c.env.JWT_SECRET || CONFIG.JWT_SECRET, 'HS256');
    } catch (e) {
      authType = 'oauth';
    }

    if (authType === 'oauth') {
      const tokenHash = await hashToken(token);
      const { results: accessTokens } = await db.prepare(
        'SELECT user_id, scope FROM oauth_access_tokens WHERE token_hash = ? AND revoked = 0 AND expires_at > ?'
      ).bind(tokenHash, currentTime).all();

      if (accessTokens.length === 0) {
        const redirect = maybeRedirectToLogin();
        if (redirect) return redirect;
        return c.json({ error: 'Unauthorized' }, 401);
      }

      const { results: users } = await db.prepare(
        'SELECT id, username_original, email, role, is_child FROM users WHERE id = ?'
      ).bind(accessTokens[0].user_id).all();

      if (users.length === 0) {
        return c.json({ error: 'Unauthorized' }, 401);
      }

      const user = users[0];
      payload = {
        user_id: user.id,
        username: user.username_original,
        role: user.role,
        is_child: Boolean(user.is_child),
        oauth_scopes: accessTokens[0].scope,
      };
    }

    let session = null;
    if (authType === 'jwt') {
      const tokenHash = await hashToken(token);
      const { results: sessions } = await db.prepare(
        'SELECT * FROM user_sessions WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?'
      ).bind(tokenHash, currentTime).all();

      if (sessions.length === 0) {
        // Legacy tokens are on borrowed time; let them pass until cutoff.
        if (currentTime > CONFIG.LEGACY_TOKEN_DEADLINE) {
          clearAuthCookie();
          const redirect = maybeRedirectToLogin();
          if (redirect) return redirect;
          return c.json({
            error: 'Session expired. Please sign in again.',
            code: 'LEGACY_TOKEN_EXPIRED',
            requires_reauth: true,
          }, 401);
        }

        c.set('user', payload);
        c.set('session', null);
        c.set('session_trust', 'legacy');
        c.set('legacy_reauth_recommended', true);
        await next();
        return;
      }

      session = sessions[0];
    }

    const { results: userStatus } = await db.prepare(
      'SELECT is_banned, is_locked, lock_expires_at FROM users WHERE id = ?'
    ).bind(payload.user_id).all();

    if (userStatus.length > 0) {
      const currentTime = now();
      const userRecord = userStatus[0];
      const requestPath = new URL(c.req.url).pathname;
      const allowRestrictedSupport = requestPath === '/support/tickets' && c.req.method === 'POST';

      // Allow banned/locked users to file support tickets, but block everything else.
      if (userRecord.is_banned) {
        if (!allowRestrictedSupport) {
          return c.json({
            error: 'Your account has been banned',
            code: 'ACCOUNT_BANNED',
            requires_reauth: false,
          }, 403);
        }

        c.set('restricted_account', {
          is_banned: true,
          is_locked: false,
          lock_expires_at: null,
        });
      }

      if (userRecord.is_locked) {
        if (userRecord.lock_expires_at && userRecord.lock_expires_at <= currentTime) {
          await db.prepare(
            'UPDATE users SET is_locked = 0, lock_reason = NULL, locked_at = NULL, locked_by = NULL, lock_expires_at = NULL WHERE id = ?'
          ).bind(payload.user_id).run();
        } else {
          if (!allowRestrictedSupport) {
            return c.json({
              error: 'Your account has been temporarily locked',
              code: 'ACCOUNT_LOCKED',
              requires_reauth: false,
              lock_expires_at: userRecord.lock_expires_at,
            }, 403);
          }

          c.set('restricted_account', {
            is_banned: false,
            is_locked: true,
            lock_expires_at: userRecord.lock_expires_at,
          });
        }
      }
    }

    let sessionTrust = 'oauth';
    if (authType === 'jwt') {
      const currentFingerprint = collectFingerprint(c);

      const validation = validateSessionFingerprint(session, currentFingerprint);

      if (!validation.valid) {
        const { results: users } = await db.prepare(
          'SELECT email FROM users WHERE id = ?'
        ).bind(payload.user_id).all();
        const user = users[0] || {};

        if (validation.trustLevel === 'suspicious') {
          const updateResult = await db.prepare(
            'UPDATE user_sessions SET revoked_at = ?, trust_level = ?, flag_reason = ? WHERE id = ? AND revoked_at IS NULL'
          ).bind(currentTime, 'blocked', 'country_mismatch', session.id).run();

          if (updateResult.meta?.changes > 0) {
            await logSecurityEvent(db, 'country_change', session.id, payload.user_id,
              currentFingerprint.ip, currentFingerprint.ipCountry, {
              originalCountry: session.ip_country,
              newCountry: currentFingerprint.ipCountry,
              validation: validation.matchDetails,
            });

            await sendSecurityAlert(c, user, 'Suspicious login from different country', {
              ip: currentFingerprint.ip,
              country: currentFingerprint.ipCountry,
              originalCountry: session.ip_country,
            });
          }

          return c.json({
            error: 'Session blocked due to suspicious activity',
            code: 'SESSION_BLOCKED_COUNTRY',
            requires_reauth: true,
          }, 401);
        }

        await logSecurityEvent(db, 'fingerprint_mismatch', session.id, payload.user_id,
          currentFingerprint.ip, currentFingerprint.ipCountry, {
          validation: validation.matchDetails,
          reason: validation.reason,
        });

        return c.json({
          error: 'Session validation failed. Please sign in again.',
          code: 'SESSION_FINGERPRINT_MISMATCH',
          requires_reauth: true,
        }, 401);
      }

      if (validation.trustLevel === 'partial' && session.trust_level !== 'partial') {
        // Downgrade trust once, then just keep last_active_at warm.
        await db.prepare(
          'UPDATE user_sessions SET last_active_at = ?, trust_level = ?, flagged_at = ?, flag_reason = ? WHERE id = ?'
        ).bind(currentTime, 'partial', currentTime, validation.reason, session.id).run();

        await logSecurityEvent(db, 'ip_change', session.id, payload.user_id,
          currentFingerprint.ip, currentFingerprint.ipCountry, {
          originalIP: session.ip_address,
          newIP: currentFingerprint.ip,
          validation: validation.matchDetails,
        });
      } else {
        await db.prepare(
          'UPDATE user_sessions SET last_active_at = ? WHERE id = ?'
        ).bind(currentTime, session.id).run();
      }

      sessionTrust = validation.trustLevel;
    }

    c.set('user', payload);
    c.set('session', session);
    c.set('session_trust', sessionTrust);
    await next();
  } catch (e) {
    console.log('authMiddleware caught:', String(e));
    console.log('authMiddleware stack:', e?.stack);
    return c.json({ error: 'Auth middleware error', detail: String(e) }, 500);
  }
};

export const adminMiddleware = async (c, next) => {
  const user = c.get('user');
  if (user.role !== 'admin') {
    return c.json({ error: 'Forbidden' }, 403);
  }
  await next();
};

export const staffMiddleware = async (c, next) => {
  const user = c.get('user');
  if (user.role !== 'admin' && user.role !== 'support') {
    return c.json({ error: 'Forbidden' }, 403);
  }
  await next();
};
