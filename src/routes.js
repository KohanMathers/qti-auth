import { verify } from 'hono/jwt';

import { CONFIG, RATE_LIMITS, REPORT_SUBTYPES, REPORT_TYPES } from './config.js';
import { adminMiddleware, authMiddleware, staffMiddleware } from './middleware.js';
import {
  base64UrlDecode,
  base64UrlEncode,
  base64UrlEncodeString,
  buildUserClaims,
  calculateAge,
  checkProfanity,
  checkRateLimit,
  createSecureSession,
  createSession,
  generateAtHash,
  generateId,
  generateLinkCode,
  generateSecureToken,
  getClientIP,
  getIssuer,
  hashToken,
  importPrivateKey,
  importPublicKey,
  isValidDateOfBirth,
  normalizeEmail,
  normalizeUsername,
  now,
  signJwtRS256,
  slugify,
  validateRedirectUri,
  validateScopes,
  validateUsername,
  verifyPKCE,
} from './lib.js';

export function registerRoutes(app) {

  // OAuth entrypoints for third-party providers.
  app.post('/auth/oauth/start', async (c) => {
    const { provider } = await c.req.json();
    const db = c.env.DB;

    const state = generateId();
    const redirectUri = (c.env.OAUTH_REDIRECT_URI || 'https://auth.quietterminal.co.uk/auth/oauth/callback').trim();

    try {
      await db.prepare(`
        INSERT INTO oauth_states (state, provider, created_at)
        VALUES (?, ?, ?)
      `).bind(state, provider, now()).run();
    } catch (e) {
      console.error('Failed to persist oauth state:', e);
    }

    let url;
    if (provider === 'google') {
      const clientId = (c.env.GOOGLE_CLIENT_ID || '').trim();
      if (!clientId) return c.json({ error: 'Google client ID not configured' }, 500);
      const scope = encodeURIComponent('openid email profile');
      url = `https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${scope}&state=${state}&prompt=consent`;
    } else if (provider === 'github') {
      const clientId = (c.env.GITHUB_CLIENT_ID || '').trim();
      if (!clientId) return c.json({ error: 'GitHub client ID not configured' }, 500);
      const scope = encodeURIComponent('read:user user:email');
      url = `https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${scope}&state=${state}`;
    } else if (provider === 'discord') {
      const clientId = (c.env.DISCORD_CLIENT_ID || '').trim();
      if (!clientId) return c.json({ error: 'Discord client ID not configured' }, 500);
      const scope = encodeURIComponent('identify email');
      url = `https://discord.com/api/oauth2/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${scope}&state=${state}`;
    } else {
      return c.json({ error: 'Invalid provider' }, 400);
    }

    return c.json({ redirect_url: url, state });
  });

  // GET variant supports direct navigation without a JSON fetch.
  app.get('/auth/oauth/start', async (c) => {
    const { provider } = c.req.query();

    const db = c.env.DB;
    const redirectUri = c.env.OAUTH_REDIRECT_URI || 'https://auth.quietterminal.co.uk/auth/oauth/callback';
    const state = generateId();
    let url;
    if (provider === 'google') {
      const clientId = (c.env.GOOGLE_CLIENT_ID || '').trim();
      if (!clientId) return c.json({ error: 'Google client ID not configured' }, 500);
      const scope = encodeURIComponent('openid email profile');
      url = `https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${scope}&state=${state}&prompt=consent`;
      try { await db.prepare('INSERT INTO oauth_states (state, provider, created_at) VALUES (?, ?, ?)').bind(state, 'google', now()).run(); } catch (e) { console.error('Failed to persist oauth state (GET):', e); }
    } else if (provider === 'github') {
      const clientId = (c.env.GITHUB_CLIENT_ID || '').trim();
      if (!clientId) return c.json({ error: 'GitHub client ID not configured' }, 500);
      const scope = encodeURIComponent('read:user user:email');
      url = `https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${scope}&state=${state}`;
      try { await db.prepare('INSERT INTO oauth_states (state, provider, created_at) VALUES (?, ?, ?)').bind(state, 'github', now()).run(); } catch (e) { console.error('Failed to persist oauth state (GET):', e); }
    } else if (provider === 'discord') {
      const clientId = (c.env.DISCORD_CLIENT_ID || '').trim();
      if (!clientId) return c.json({ error: 'Discord client ID not configured' }, 500);
      const scope = encodeURIComponent('identify email');
      url = `https://discord.com/api/oauth2/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${scope}&state=${state}`;
      try { await db.prepare('INSERT INTO oauth_states (state, provider, created_at) VALUES (?, ?, ?)').bind(state, 'discord', now()).run(); } catch (e) { console.error('Failed to persist oauth state (GET):', e); }
    } else {
      return c.json({ error: 'Invalid provider' }, 400);
    }

    return c.redirect(url);
  });

  // Provider callback: trade code for identity and route into our session flow.
  app.get('/auth/oauth/callback', async (c) => {
    const { code, state } = c.req.query();
    let provider = c.req.query().provider;
    const db = c.env.DB;

    if (!code) return c.json({ error: 'Missing code' }, 400);

    let oauthUser = { provider, id: null, email: null, birthdate: null };

    if (!provider && state) {
      try {
        const { results: stateRows } = await db.prepare(
          'SELECT provider FROM oauth_states WHERE state = ?'
        ).bind(state).all();

        if (stateRows.length > 0) {
          oauthUser.provider = stateRows[0].provider;
          await db.prepare('DELETE FROM oauth_states WHERE state = ?').bind(state).run();
        } else {
          return c.json({ error: 'Unknown OAuth state; provider not found' }, 400);
        }
      } catch (e) {
        console.error('Failed to lookup oauth state:', e);
        return c.json({ error: 'Failed to validate oauth state' }, 500);
      }
    }

    if (!provider && oauthUser.provider) {
      provider = oauthUser.provider;
    }

    try {
      if (provider === 'google') {
        const clientId = (c.env.GOOGLE_CLIENT_ID || '').trim();
        const clientSecret = (c.env.GOOGLE_CLIENT_SECRET || '').trim();
        const redirectUri = (c.env.OAUTH_REDIRECT_URI || 'https://auth.quietterminal.co.uk/auth/oauth/callback').trim();
        if (!clientId || !clientSecret) return c.json({ error: 'Google client credentials not configured' }, 500);

        const params = new URLSearchParams();
        params.append('code', code);
        params.append('client_id', clientId);
        params.append('client_secret', clientSecret);
        params.append('redirect_uri', redirectUri);
        params.append('grant_type', 'authorization_code');

        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: params.toString(),
        });

        if (!tokenRes.ok) {
          const text = await tokenRes.text();
          console.error('Google token error:', text);
          return c.json({ error: 'Failed to exchange Google code' }, 500);
        }

        const tokenJson = await tokenRes.json();
        const accessToken = tokenJson.access_token;

        const userRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
          headers: { Authorization: `Bearer ${accessToken}` },
        });

        if (!userRes.ok) {
          const text = await userRes.text();
          console.error('Google userinfo error:', text);
          return c.json({ error: 'Failed to fetch Google user info' }, 500);
        }

        const userInfo = await userRes.json();
        oauthUser.id = userInfo.sub;
        oauthUser.email = userInfo.email;
        oauthUser.birthdate = userInfo.birthdate || null;

      } else if (provider === 'github') {
        const clientId = (c.env.GITHUB_CLIENT_ID || '').trim();
        const clientSecret = (c.env.GITHUB_CLIENT_SECRET || '').trim();
        const redirectUri = (c.env.OAUTH_REDIRECT_URI || 'https://auth.quietterminal.co.uk/auth/oauth/callback').trim();
        if (!clientId || !clientSecret) return c.json({ error: 'GitHub client credentials not configured' }, 500);

        const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
          method: 'POST',
          headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'QuietTerminalAuth/1.0' },
          body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
        });

        if (!tokenRes.ok) {
          const text = await tokenRes.text();
          console.error('GitHub token error:', text);
          return c.json({ error: 'Failed to exchange GitHub code' }, 500);
        }

        const tokenJson = await tokenRes.json();
        const accessToken = tokenJson.access_token;

        const userRes = await fetch('https://api.github.com/user', {
          headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/vnd.github.v3+json', 'User-Agent': 'QuietTerminalAuth/1.0' },
        });

        if (!userRes.ok) {
          const text = await userRes.text();
          console.error('GitHub user error:', text, 'token response:', tokenJson);
          const safeToken = Object.assign({}, tokenJson);
          if (safeToken && safeToken.access_token) safeToken.access_token = '<redacted>';
          return c.json({ error: 'Failed to fetch GitHub user', details: text, token: safeToken }, 500);
        }

        const userInfo = await userRes.json();
        oauthUser.id = String(userInfo.id);
        let email = userInfo.email;
        if (!email) {
          const emailsRes = await fetch('https://api.github.com/user/emails', {
            headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/vnd.github.v3+json', 'User-Agent': 'QuietTerminalAuth/1.0' },
          });
          if (emailsRes.ok) {
            const emails = await emailsRes.json();
            const primary = emails.find(e => e.primary && e.verified) || emails.find(e => e.verified) || emails[0];
            if (primary) email = primary.email;
          }
        }
        oauthUser.email = email;
        oauthUser.birthdate = null;

      } else if (provider === 'discord') {
        const clientId = (c.env.DISCORD_CLIENT_ID || '').trim();
        const clientSecret = (c.env.DISCORD_CLIENT_SECRET || '').trim();
        const redirectUri = (c.env.OAUTH_REDIRECT_URI || 'https://auth.quietterminal.co.uk/auth/oauth/callback').trim();
        if (!clientId || !clientSecret) return c.json({ error: 'Discord client credentials not configured' }, 500);

        const params = new URLSearchParams();
        params.append('client_id', clientId);
        params.append('client_secret', clientSecret);
        params.append('grant_type', 'authorization_code');
        params.append('code', code);
        params.append('redirect_uri', redirectUri);

        const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: params.toString(),
        });

        if (!tokenRes.ok) {
          const text = await tokenRes.text();
          console.error('Discord token error:', text);
          return c.json({ error: 'Failed to exchange Discord code' }, 500);
        }

        const tokenJson = await tokenRes.json();
        const accessToken = tokenJson.access_token;

        const userRes = await fetch('https://discord.com/api/users/@me', {
          headers: { Authorization: `Bearer ${accessToken}` },
        });

        if (!userRes.ok) {
          const text = await userRes.text();
          console.error('Discord user error:', text);
          return c.json({ error: 'Failed to fetch Discord user' }, 500);
        }

        const userInfo = await userRes.json();
        oauthUser.id = String(userInfo.id);
        oauthUser.email = userInfo.email || null;
        oauthUser.birthdate = null;

      } else {
        return c.json({ error: 'Unsupported provider' }, 400);
      }
    } catch (err) {
      console.error('OAuth callback error:', err);
      return c.json({ error: 'OAuth callback processing failed' }, 500);
    }

    const emailNorm = normalizeEmail(oauthUser.email);

    const { results } = await db.prepare(
      'SELECT * FROM users WHERE oauth_provider = ? AND oauth_id = ?'
    ).bind(provider, oauthUser.id).all();

    let user = results[0];

    if (user) {
      if (user.is_banned) {
        const accept = c.req.header('accept') || '';
        const frontendUrl = c.env.FRONTEND_URL || 'https://account.quietterminal.co.uk';
        if (accept.includes('text/html')) {
          return c.redirect(`${frontendUrl}/login?error=account_banned`);
        }
        return c.json({ error: 'Your account has been banned' }, 403);
      }

      if (user.is_locked) {
        const currentTime = now();
        if (user.lock_expires_at && user.lock_expires_at <= currentTime) {
          await db.prepare(
            'UPDATE users SET is_locked = 0, lock_reason = NULL, locked_at = NULL, locked_by = NULL, lock_expires_at = NULL WHERE id = ?'
          ).bind(user.id).run();
        } else {
          const accept = c.req.header('accept') || '';
          const frontendUrl = c.env.FRONTEND_URL || 'https://account.quietterminal.co.uk';
          if (accept.includes('text/html')) {
            return c.redirect(`${frontendUrl}/login?error=account_locked`);
          }
          return c.json({
            error: 'Your account has been temporarily locked',
            lock_expires_at: user.lock_expires_at,
          }, 403);
        }
      }

      await db.prepare(
        'UPDATE users SET updated_at = ? WHERE id = ?'
      ).bind(now(), user.id).run();
    } else {
      if (!oauthUser.birthdate) {
        const tempToken = generateId();
        try {
          await db.prepare(`
            INSERT INTO oauth_temp (id, provider, oauth_id, email, created_at)
            VALUES (?, ?, ?, ?, ?)
          `).bind(tempToken, oauthUser.provider, oauthUser.id, oauthUser.email, now()).run();
        } catch (e) {
          console.error('Failed to persist oauth_temp:', e);
        }

        const accept = c.req.header('accept') || '';
        const frontendUrl = c.env.FRONTEND_URL || 'https://account.quietterminal.co.uk';
        const redirectUrl = `${frontendUrl}/age-verify?temp_token=${tempToken}`;
        if (accept.includes('text/html')) {
          return c.redirect(redirectUrl);
        }

        return c.json({
          needs_age_verification: true,
          temp_token: tempToken,
        });
      }

      const { results: existingCount } = await db.prepare(
        'SELECT COUNT(*) as count FROM users WHERE email_normalized = ?'
      ).bind(emailNorm).all();

      if (existingCount[0].count >= CONFIG.MAX_ACCOUNTS_PER_EMAIL) {
        const accept = c.req.header('accept') || '';
        const frontendUrl = c.env.FRONTEND_URL || 'https://account.quietterminal.co.uk';
        if (accept.includes('text/html')) {
          return c.redirect(`${frontendUrl}/login?error=max_accounts`);
        }
        return c.json({ error: 'This email already has the maximum number of accounts' }, 400);
      }

      const userId = generateId();
      const age = calculateAge(oauthUser.birthdate);

      await db.prepare(`
        INSERT INTO users (
          id, email, email_normalized, oauth_provider, oauth_id,
          date_of_birth, is_child, age_verified_at, age_verification_method,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        userId,
        oauthUser.email,
        emailNorm,
        provider,
        oauthUser.id,
        oauthUser.birthdate,
        age < 18 ? 1 : 0,
        now(),
        'oauth',
        now(),
        now()
      ).run();

      user = { id: userId, email: oauthUser.email, role: 'user', is_child: age < 18 };
    }

    if (!user.username_original) {
      const { token: sessionToken } = await createSecureSession(c, user, `oauth_${provider}`);
      try {
        const domain = c.env.COOKIE_DOMAIN || '.quietterminal.co.uk';
        const cookie = `qti_token=${sessionToken}; Path=/; Domain=${domain}; HttpOnly; Secure; SameSite=None; Max-Age=${CONFIG.SESSION_DURATION}`;
        c.header('Set-Cookie', cookie);
      } catch (e) {
        console.error('Failed to set cookie on OAuth callback (needs_username):', e);
      }

      const accept = c.req.header('accept') || '';
      const frontendUrl = c.env.FRONTEND_URL || 'https://account.quietterminal.co.uk';

      if (accept.includes('text/html')) {
        return c.redirect(`${frontendUrl}/claim-username?token=${sessionToken}`);
      }

      return c.json({
        needs_username: true,
        token: sessionToken,
        user: { id: user.id, email: user.email },
      });
    }

    const { token } = await createSecureSession(c, user, `oauth_${provider}`);
    try {
      const domain = c.env.COOKIE_DOMAIN || '.quietterminal.co.uk';
      const cookie = `qti_token=${token}; Path=/; Domain=${domain}; HttpOnly; Secure; SameSite=None; Max-Age=${CONFIG.SESSION_DURATION}`;
      c.header('Set-Cookie', cookie);
    } catch (e) {
      console.error('Failed to set cookie on OAuth callback:', e);
    }

    const accept = c.req.header('accept') || '';
    const frontendUrl = c.env.FRONTEND_URL || 'https://account.quietterminal.co.uk';
    if (accept.includes('text/html')) {
      return c.redirect(`${frontendUrl}/verify?token=${token}`);
    }

    return c.json({ token, user });
  });


  // Email magic link flow, with layered rate limits.
  app.post('/auth/email/start', async (c) => {
    const { email, date_of_birth } = await c.req.json();
    const db = c.env.DB;
    const clientIP = getClientIP(c);

    if (!email) {
      return c.json({ error: 'Email required' }, 400);
    }

    const emailNorm = normalizeEmail(email);

    const { results: existingUsers } = await db.prepare(
      'SELECT * FROM users WHERE email_normalized = ? AND oauth_provider IS NULL'
    ).bind(emailNorm).all();

    const userExists = existingUsers.length > 0;

    if (!userExists && !date_of_birth) {
      return c.json({ error: 'Date of birth required for new accounts' }, 400);
    }

    if (date_of_birth && !isValidDateOfBirth(date_of_birth)) {
      return c.json({ error: 'Invalid date of birth' }, 400);
    }

    const emailRateLimit = await checkRateLimit(
      db,
      `email_auth:${emailNorm}`,
      RATE_LIMITS.EMAIL_REQUESTS_PER_HOUR,
      3600
    );

    if (!emailRateLimit.allowed) {
      return c.json({
        error: 'Too many requests for this email address. Please try again later.',
        retry_after: 3600
      }, 429);
    }

    const ipHourlyLimit = await checkRateLimit(
      db,
      `email_auth_ip_hour:${clientIP}`,
      RATE_LIMITS.EMAIL_REQUESTS_PER_IP_HOUR,
      3600
    );

    if (!ipHourlyLimit.allowed) {
      return c.json({
        error: 'Too many requests from your network. Please try again in an hour.',
        retry_after: 3600
      }, 429);
    }

    const ipDailyLimit = await checkRateLimit(
      db,
      `email_auth_ip_day:${clientIP}`,
      RATE_LIMITS.EMAIL_REQUESTS_PER_IP_DAY,
      86400
    );

    if (!ipDailyLimit.allowed) {
      return c.json({
        error: 'Daily limit reached. Please try again tomorrow.',
        retry_after: 86400
      }, 429);
    }

    if (!userExists) {
      const { results: existingCount } = await db.prepare(
        'SELECT COUNT(*) as count FROM users WHERE email_normalized = ?'
      ).bind(emailNorm).all();

      if (existingCount[0].count >= CONFIG.MAX_ACCOUNTS_PER_EMAIL) {
        return c.json({ error: 'This email already has the maximum number of accounts' }, 400);
      }
    }

    const token = generateId();
    const tokenHash = await hashToken(token);

    await db.prepare(`
      INSERT INTO email_tokens (
        id, email, email_normalized, token_hash, date_of_birth, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      generateId(),
      email,
      emailNorm,
      tokenHash,
      userExists ? (existingUsers[0].date_of_birth || date_of_birth) : date_of_birth,
      now() + CONFIG.EMAIL_TOKEN_EXPIRY,
      now()
    ).run();

    const magicLink = `${c.env.FRONTEND_URL}/verify?token=${token}`;

    try {
      const emailResponse = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'api-key': c.env.EMAIL_SERVICE_API_KEY,
        },
        body: JSON.stringify({
          sender: {
            name: 'QTI Auth',
            email: 'auth@account.quietterminal.co.uk',
          },
          to: [{
            email: email,
            name: email.split('@')[0],
          }],
          subject: 'Sign in to QTI',
          htmlContent: `
            <!DOCTYPE html>
            <html>
            <head>
              <meta charset="utf-8">
              <style>
                body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
                .container { max-width: 600px; margin: 0 auto; padding: 40px 20px; }
                .button {
                  display: inline-block;
                  padding: 12px 24px;
                  background: #3b82f6;
                  color: white;
                  text-decoration: none;
                  border-radius: 6px;
                  font-weight: 600;
                }
                .footer { margin-top: 40px; font-size: 12px; color: #6b7280; }
              </style>
            </head>
            <body>
              <div class="container">
                <h1>Sign in to QTI</h1>
                <p>Click the button below to sign in to your QTI account:</p>
                <p><a href="${magicLink}" class="button">Sign In</a></p>
                <p>Or copy and paste this link into your browser:</p>
                <p style="word-break: break-all; color: #6b7280;">${magicLink}</p>
                <p><strong>This link expires in 15 minutes.</strong></p>
                <div class="footer">
                  <p>If you didn't request this email, you can safely ignore it.</p>
                  <p>&copy; ${new Date().getFullYear()} Quiet Terminal Interactive. All rights reserved.</p>
                </div>
              </div>
            </body>
            </html>
          `,
        }),
      });

      if (!emailResponse.ok) {
        console.error('Email sending failed:', await emailResponse.text());
        return c.json({
          error: 'Failed to send verification email. Please try again.'
        }, 500);
      }
    } catch (error) {
      console.error('Email error:', error);
      return c.json({
        error: 'Failed to send verification email. Please try again.'
      }, 500);
    }

    return c.json({
      message: 'Verification email sent. Please check your inbox.',
      email: email,
      rate_limit: {
        remaining: emailRateLimit.remaining,
        reset_in: 3600
      }
    });
  });

  // Global request limiter to keep the edge from melting.
  app.use('/*', async (c, next) => {
    const db = c.env.DB;
    const clientIP = getClientIP(c);

    const globalLimit = await checkRateLimit(
      db,
      `global:${clientIP}`,
      RATE_LIMITS.GLOBAL_REQUESTS_PER_MINUTE,
      60
    );

    if (!globalLimit.allowed) {
      return c.json({
        error: 'Rate limit exceeded. Please slow down.',
        retry_after: 60
      }, 429);
    }

    await next();
  });

  // Magic link verification also provisions sessions for new users.
  app.post('/auth/email/verify', async (c) => {
    const { token } = await c.req.json();
    const db = c.env.DB;

    const tokenHash = await hashToken(token);

    const { results } = await db.prepare(
      'SELECT * FROM email_tokens WHERE token_hash = ? AND used = 0 AND expires_at > ?'
    ).bind(tokenHash, now()).all();

    if (results.length === 0) {
      return c.json({ error: 'Invalid or expired token' }, 400);
    }

    const tokenData = results[0];

    await db.prepare(
      'UPDATE email_tokens SET used = 1 WHERE id = ?'
    ).bind(tokenData.id).run();

    const { results: users } = await db.prepare(
      'SELECT * FROM users WHERE email_normalized = ? AND oauth_provider IS NULL'
    ).bind(tokenData.email_normalized).all();

    let user;

    if (users.length > 0) {
      user = users[0];

      if (user.is_banned) {
        return c.json({ error: 'Your account has been banned' }, 403);
      }

      if (user.is_locked) {
        const currentTime = now();
        if (user.lock_expires_at && user.lock_expires_at <= currentTime) {
          await db.prepare(
            'UPDATE users SET is_locked = 0, lock_reason = NULL, locked_at = NULL, locked_by = NULL, lock_expires_at = NULL WHERE id = ?'
          ).bind(user.id).run();
        } else {
          return c.json({
            error: 'Your account has been temporarily locked',
            lock_expires_at: user.lock_expires_at,
          }, 403);
        }
      }
    } else {
      const userId = generateId();
      const age = calculateAge(tokenData.date_of_birth);

      await db.prepare(`
        INSERT INTO users (
          id, email, email_normalized, date_of_birth, is_child,
          age_verified_at, age_verification_method, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        userId,
        tokenData.email,
        tokenData.email_normalized,
        tokenData.date_of_birth,
        age < 18 ? 1 : 0,
        now(),
        'self_declaration',
        now(),
        now()
      ).run();

      user = {
        id: userId,
        email: tokenData.email,
        role: 'user',
        is_child: age < 18,
        username_original: null,
      };
    }

    if (!user.username_original) {
      const { token: sessionToken } = await createSecureSession(c, user, 'email');

      try {
        const domain = c.env.COOKIE_DOMAIN || '.quietterminal.co.uk';
        const cookie = `qti_token=${sessionToken}; Path=/; Domain=${domain}; HttpOnly; Secure; SameSite=None; Max-Age=${CONFIG.SESSION_DURATION}`;
        c.header('Set-Cookie', cookie);
      } catch (e) {
        console.error('Failed to set cookie:', e);
      }

      return c.json({
        needs_username: true,
        user: { id: user.id, email: user.email },
        token: sessionToken,
      });
    }

    const { token: sessionToken } = await createSecureSession(c, user, 'email');

    try {
      const domain = c.env.COOKIE_DOMAIN || '.quietterminal.co.uk';
      const cookie = `qti_token=${sessionToken}; Path=/; Domain=${domain}; HttpOnly; Secure; SameSite=None; Max-Age=${CONFIG.SESSION_DURATION}`;
      c.header('Set-Cookie', cookie);
    } catch (e) {
      console.error('Failed to set cookie:', e);
    }

    return c.json({ token: sessionToken, user });
  });


  app.post('/auth/age/verify', async (c) => {
    const { temp_token, date_of_birth } = await c.req.json();
    const db = c.env.DB;

    if (!temp_token) {
      return c.json({ error: 'Missing temp_token' }, 400);
    }

    if (!isValidDateOfBirth(date_of_birth)) {
      return c.json({ error: 'Invalid date of birth' }, 400);
    }

    const { results: temps } = await db.prepare(
      'SELECT * FROM oauth_temp WHERE id = ?'
    ).bind(temp_token).all();

    if (temps.length === 0) {
      return c.json({ error: 'Invalid or expired temp token' }, 400);
    }

    const temp = temps[0];
    const age = calculateAge(date_of_birth);
    const emailNorm = normalizeEmail(temp.email);

    const { results: existingCount } = await db.prepare(
      'SELECT COUNT(*) as count FROM users WHERE email_normalized = ?'
    ).bind(emailNorm).all();

    if (existingCount[0].count >= CONFIG.MAX_ACCOUNTS_PER_EMAIL) {
      return c.json({ error: 'This email already has the maximum number of accounts' }, 400);
    }

    const userId = generateId();

    await db.prepare(`
      INSERT INTO users (
        id, email, email_normalized, oauth_provider, oauth_id,
        date_of_birth, is_child, age_verified_at, age_verification_method,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      userId,
      temp.email,
      emailNorm,
      temp.provider,
      temp.oauth_id,
      date_of_birth,
      age < 18 ? 1 : 0,
      now(),
      'oauth',
      now(),
      now()
    ).run();

    await db.prepare('DELETE FROM oauth_temp WHERE id = ?').bind(temp_token).run();

    const user = { id: userId, email: temp.email, role: 'user', is_child: age < 18, username_original: null };

    const { token: sessionToken } = await createSecureSession(c, user, `oauth_${temp.provider}`);
    try {
      const domain = c.env.COOKIE_DOMAIN || '.quietterminal.co.uk';
      const cookie = `qti_token=${sessionToken}; Path=/; Domain=${domain}; HttpOnly; Secure; SameSite=None; Max-Age=${CONFIG.SESSION_DURATION}`;
      c.header('Set-Cookie', cookie);
    } catch (e) {
      console.error('Failed to set cookie on age verify:', e);
    }

    if (!user.username_original) {
      return c.json({ needs_username: true, user: { id: user.id, email: user.email }, token: sessionToken });
    }

    return c.json({ token: sessionToken, user });
  });


  app.post('/username/claim', authMiddleware, async (c) => {
    const user = c.get('user');
    const { username } = await c.req.json();
    const db = c.env.DB;

    const { results: existing } = await db.prepare(
      'SELECT username_original FROM users WHERE id = ?'
    ).bind(user.user_id).all();

    if (existing[0]?.username_original) {
      return c.json({ error: 'Username already claimed' }, 400);
    }

    const validationErrors = validateUsername(username);
    if (validationErrors.length > 0) {
      return c.json({ error: validationErrors[0] }, 400);
    }

    const profanityCheck = await checkProfanity(username, db);
    if (profanityCheck.isProfane) {
      return c.json({ error: 'Username contains prohibited words' }, 400);
    }

    const canonical = normalizeUsername(username);
    const { results: duplicates } = await db.prepare(
      'SELECT id FROM users WHERE username_canonical = ?'
    ).bind(canonical).all();

    if (duplicates.length > 0) {
      return c.json({ error: 'Username unavailable' }, 400);
    }

    await db.prepare(`
      UPDATE users 
      SET username_original = ?, username_canonical = ?, updated_at = ?
      WHERE id = ?
    `).bind(username, canonical, now(), user.user_id).run();

    await db.prepare(`
      INSERT INTO username_history (user_id, new_username, changed_at, changed_reason)
      VALUES (?, ?, ?, ?)
    `).bind(user.user_id, username, now(), 'initial_claim').run();

    return c.json({ username });
  });

  app.post('/username/change', authMiddleware, async (c) => {
    const user = c.get('user');
    const { new_username } = await c.req.json();
    const db = c.env.DB;

    const validationErrors = validateUsername(new_username);
    if (validationErrors.length > 0) {
      return c.json({ error: validationErrors[0] }, 400);
    }

    const profanityCheck = await checkProfanity(new_username, db);
    if (profanityCheck.isProfane) {
      return c.json({ error: 'Username contains prohibited words' }, 400);
    }

    if (user.role !== 'admin') {
      const { results: cooldown } = await db.prepare(
        'SELECT * FROM username_cooldowns WHERE user_id = ?'
      ).bind(user.user_id).all();

      if (cooldown.length > 0) {
        const cd = cooldown[0];
        const timeSinceChange = now() - cd.last_change_at;

        if (timeSinceChange < CONFIG.USERNAME_CHANGE_COOLDOWN) {
          const daysLeft = Math.ceil((CONFIG.USERNAME_CHANGE_COOLDOWN - timeSinceChange) / 86400);
          return c.json({ error: `You must wait ${daysLeft} more days to change your username` }, 400);
        }

        const currentYear = new Date().getFullYear();
        if (cd.year === currentYear && cd.change_count_this_year >= CONFIG.MAX_USERNAME_CHANGES_PER_YEAR) {
          return c.json({ error: 'You have reached the maximum number of username changes this year' }, 400);
        }
      }
    }

    const canonical = normalizeUsername(new_username);
    const { results: duplicates } = await db.prepare(
      'SELECT id FROM users WHERE username_canonical = ? AND id != ?'
    ).bind(canonical, user.user_id).all();

    if (duplicates.length > 0) {
      return c.json({ error: 'Username unavailable' }, 400);
    }

    const { results: userData } = await db.prepare(
      'SELECT username_original FROM users WHERE id = ?'
    ).bind(user.user_id).all();

    const oldUsername = userData[0].username_original;

    await db.prepare(`
      UPDATE users 
      SET username_original = ?, username_canonical = ?, updated_at = ?
      WHERE id = ?
    `).bind(new_username, canonical, now(), user.user_id).run();

    await db.prepare(`
      INSERT INTO username_history (user_id, old_username, new_username, changed_at, changed_reason)
      VALUES (?, ?, ?, ?, ?)
    `).bind(user.user_id, oldUsername, new_username, now(), 'user_change').run();

    const currentYear = new Date().getFullYear();
    await db.prepare(`
      INSERT INTO username_cooldowns (user_id, last_change_at, change_count_this_year, year)
      VALUES (?, ?, 1, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        last_change_at = excluded.last_change_at,
        change_count_this_year = CASE 
          WHEN year = excluded.year THEN change_count_this_year + 1
          ELSE 1
        END,
        year = excluded.year
    `).bind(user.user_id, now(), currentYear).run();

    return c.json({ username: new_username });
  });


  app.get('/me', authMiddleware, async (c) => {
    const user = c.get('user');
    const db = c.env.DB;

    const { results } = await db.prepare(
      'SELECT id, username_original, email, role, is_child, date_of_birth, created_at FROM users WHERE id = ?'
    ).bind(user.user_id).all();

    return c.json({ user: results[0] });
  });

  app.post('/auth/session', async (c) => {
    const token = c.req.header('Authorization')?.replace('Bearer ', '');
    if (!token) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    try {
      await verify(token, c.env.JWT_SECRET || CONFIG.JWT_SECRET, "HS256");
    } catch (e) {
      return c.json({ error: 'Invalid token' }, 401);
    }

    const db = c.env.DB;
    const currentTime = now();
    const tokenHash = await hashToken(token);
    const { results: sessions } = await db.prepare(
      'SELECT id FROM user_sessions WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?'
    ).bind(tokenHash, currentTime).all();

    if (sessions.length === 0) {
      if (currentTime > CONFIG.LEGACY_TOKEN_DEADLINE) {
        return c.json({
          error: 'Session expired. Please sign in again.',
          code: 'LEGACY_TOKEN_EXPIRED',
          requires_reauth: true,
        }, 401);
      }

      return c.json({
        error: 'Session not found. Please sign in again.',
        code: 'SESSION_NOT_FOUND',
        requires_reauth: true,
      }, 401);
    }

    try {
      const domain = c.env.COOKIE_DOMAIN || '.quietterminal.co.uk';
      const cookie = `qti_token=${token}; Path=/; Domain=${domain}; HttpOnly; Secure; SameSite=None; Max-Age=${CONFIG.SESSION_DURATION}`;
      c.header('Set-Cookie', cookie);
    } catch (e) {
      console.error('Failed to set cookie via auth/session:', e);
    }

    return c.json({ success: true });
  });

  app.post('/logout', authMiddleware, async (c) => {
    const db = c.env.DB;
    const session = c.get('session');

    if (session?.id) {
      try {
        await db.prepare(
          'UPDATE user_sessions SET revoked_at = ? WHERE id = ?'
        ).bind(now(), session.id).run();
      } catch (e) {
        console.error('Failed to revoke session:', e);
      }
    }

    try {
      const domain = c.env.COOKIE_DOMAIN || '.quietterminal.co.uk';
      const cookie = `qti_token=deleted; Path=/; Domain=${domain}; HttpOnly; Secure; SameSite=None; Max-Age=0`;
      c.header('Set-Cookie', cookie);
    } catch (e) {
      console.error('Failed to clear cookie on logout:', e);
    }

    return c.json({ message: 'Logged out' });
  });


  app.post('/report/user', authMiddleware, async (c) => {
    const reporter = c.get('user');
    const {
      reported_user_id,
      report_type,
      report_subtype,
      description,
    } = await c.req.json();
    const db = c.env.DB;

    if (!Object.values(REPORT_TYPES).includes(report_type)) {
      return c.json({ error: 'Invalid report type' }, 400);
    }

    let priority = 'medium';
    if (report_type === REPORT_TYPES.ILLEGAL_CONTENT || report_subtype === REPORT_SUBTYPES.CSAM) {
      priority = 'urgent';
    } else if (report_type === REPORT_TYPES.HARMFUL_TO_CHILD || report_type === REPORT_TYPES.THREATS) {
      priority = 'high';
    }

    const reportId = generateId();

    await db.prepare(`
      INSERT INTO user_reports (
        id, reporter_user_id, reported_user_id, content_type,
        report_type, report_subtype, description, status, priority, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      reportId,
      reporter.user_id,
      reported_user_id,
      'user_profile',
      report_type,
      report_subtype || null,
      description || null,
      'pending',
      priority,
      now(),
      now()
    ).run();

    await db.prepare(`
      INSERT INTO daily_stats (date, reports_submitted, updated_at)
      VALUES (date('now'), 1, ?)
      ON CONFLICT(date) DO UPDATE SET
        reports_submitted = reports_submitted + 1,
        updated_at = excluded.updated_at
    `).bind(now()).run();

    return c.json({
      report_id: reportId,
      message: "Report received. We'll review it within 24 hours.",
    });
  });

  app.post('/report/content', authMiddleware, async (c) => {
    const reporter = c.get('user');
    const {
      reported_user_id,
      content_id,
      content_type,
      report_type,
      report_subtype,
      description,
      content_snapshot,
    } = await c.req.json();
    const db = c.env.DB;

    let priority = 'medium';
    if (report_type === REPORT_TYPES.ILLEGAL_CONTENT || report_subtype === REPORT_SUBTYPES.CSAM) {
      priority = 'urgent';
    } else if (report_type === REPORT_TYPES.HARMFUL_TO_CHILD) {
      priority = 'high';
    }

    const reportId = generateId();

    await db.prepare(`
      INSERT INTO user_reports (
        id, reporter_user_id, reported_user_id, reported_content_id, content_type,
        report_type, report_subtype, description, content_snapshot, status, priority,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      reportId,
      reporter.user_id,
      reported_user_id,
      content_id,
      content_type,
      report_type,
      report_subtype || null,
      description || null,
      content_snapshot || null,
      'pending',
      priority,
      now(),
      now()
    ).run();

    return c.json({
      report_id: reportId,
      message: "Report received. We'll review it within 24 hours.",
    });
  });

  app.get('/report/status/:id', authMiddleware, async (c) => {
    const user = c.get('user');
    const reportId = c.req.param('id');
    const db = c.env.DB;

    const { results } = await db.prepare(`
      SELECT id, status, created_at, reviewed_at
      FROM user_reports
      WHERE id = ? AND reporter_user_id = ?
    `).bind(reportId, user.user_id).all();

    if (results.length === 0) {
      return c.json({ error: 'Report not found' }, 404);
    }

    return c.json({ report: results[0] });
  });


  app.get('/moderation/queue', authMiddleware, adminMiddleware, async (c) => {
    const db = c.env.DB;

    const { results } = await db.prepare(`
      SELECT * FROM pending_reports
      LIMIT 50
    `).all();

    return c.json({ reports: results });
  });

  app.get('/moderation/report/:id', authMiddleware, adminMiddleware, async (c) => {
    const reportId = c.req.param('id');
    const db = c.env.DB;

    const { results } = await db.prepare(`
      SELECT r.*, u1.username_original as reporter_username, u2.username_original as reported_username
      FROM user_reports r
      LEFT JOIN users u1 ON r.reporter_user_id = u1.id
      LEFT JOIN users u2 ON r.reported_user_id = u2.id
      WHERE r.id = ?
    `).bind(reportId).all();

    if (results.length === 0) {
      return c.json({ error: 'Report not found' }, 404);
    }

    return c.json({ report: results[0] });
  });

  app.post('/moderation/action', authMiddleware, adminMiddleware, async (c) => {
    const admin = c.get('user');
    const {
      report_id,
      user_id,
      action_type,
      reason,
      duration,
      internal_notes,
    } = await c.req.json();
    const db = c.env.DB;

    const actionId = generateId();
    const expiresAt = duration ? now() + duration : null;

    await db.prepare(`
      INSERT INTO moderation_actions (
        id, user_id, moderator_id, action_type, duration, reason,
        related_report_id, internal_notes, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      actionId,
      user_id,
      admin.user_id,
      action_type,
      duration || null,
      reason,
      report_id || null,
      internal_notes || null,
      now(),
      expiresAt
    ).run();

    if (action_type === 'ban') {
      await db.prepare(`
        UPDATE users
        SET is_banned = 1, ban_reason = ?, banned_at = ?, banned_by = ?
        WHERE id = ?
      `).bind(reason, now(), admin.user_id, user_id).run();

      await db.prepare(`
        INSERT INTO daily_stats (date, accounts_banned, updated_at)
        VALUES (date('now'), 1, ?)
        ON CONFLICT(date) DO UPDATE SET
          accounts_banned = accounts_banned + 1,
          updated_at = excluded.updated_at
      `).bind(now()).run();
    } else if (action_type === 'unban') {
      await db.prepare(`
        UPDATE users
        SET is_banned = 0, ban_reason = NULL, banned_at = NULL, banned_by = NULL
        WHERE id = ?
      `).bind(user_id).run();
    }

    if (report_id) {
      await db.prepare(`
        UPDATE user_reports
        SET status = 'actioned', reviewed_at = ?, reviewed_by = ?, updated_at = ?
        WHERE id = ?
      `).bind(now(), admin.user_id, now(), report_id).run();

      await db.prepare(`
        INSERT INTO daily_stats (date, reports_actioned, updated_at)
        VALUES (date('now'), 1, ?)
        ON CONFLICT(date) DO UPDATE SET
          reports_actioned = reports_actioned + 1,
          updated_at = excluded.updated_at
      `).bind(now()).run();
    }

    await db.prepare(`
      INSERT INTO admin_logs (id, admin_id, action, target_id, target_type, details, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      generateId(),
      admin.user_id,
      action_type,
      user_id,
      'user',
      JSON.stringify({ report_id, reason, duration }),
      now()
    ).run();

    return c.json({ action_id: actionId, message: 'Action applied' });
  });

  app.post('/moderation/dismiss', authMiddleware, adminMiddleware, async (c) => {
    const admin = c.get('user');
    const { report_id, reason } = await c.req.json();
    const db = c.env.DB;

    await db.prepare(`
      UPDATE user_reports
      SET status = 'dismissed', reviewed_at = ?, reviewed_by = ?, review_notes = ?, updated_at = ?
      WHERE id = ?
    `).bind(now(), admin.user_id, reason, now(), report_id).run();

    return c.json({ message: 'Report dismissed' });
  });


  app.get('/admin/stats', authMiddleware, adminMiddleware, async (c) => {
    const db = c.env.DB;

    const { results: totalUsers } = await db.prepare(
      'SELECT COUNT(*) as count FROM users'
    ).all();

    const { results: childUsers } = await db.prepare(
      'SELECT COUNT(*) as count FROM users WHERE is_child = 1'
    ).all();

    const { results: bannedUsers } = await db.prepare(
      'SELECT COUNT(*) as count FROM users WHERE is_banned = 1'
    ).all();

    const { results: pendingReports } = await db.prepare(
      'SELECT COUNT(*) as count FROM user_reports WHERE status = "pending"'
    ).all();

    const { results: recentStats } = await db.prepare(
      'SELECT * FROM daily_stats ORDER BY date DESC LIMIT 30'
    ).all();

    return c.json({
      total_users: totalUsers[0].count,
      child_users: childUsers[0].count,
      banned_users: bannedUsers[0].count,
      pending_reports: pendingReports[0].count,
      recent_stats: recentStats,
    });
  });


  app.get('/sessions', authMiddleware, async (c) => {
    const user = c.get('user');
    const db = c.env.DB;
    const currentSession = c.get('session');

    const { results: sessions } = await db.prepare(`
      SELECT id, ip_address, ip_country, user_agent, device_type, auth_method,
             trust_level, created_at, last_active_at, expires_at
      FROM user_sessions
      WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
      ORDER BY last_active_at DESC
    `).bind(user.user_id, now()).all();

    const sessionsWithCurrent = sessions.map(s => ({
      ...s,
      is_current: currentSession?.id === s.id,
    }));

    return c.json({ sessions: sessionsWithCurrent });
  });

  app.post('/sessions/:sessionId/revoke', authMiddleware, async (c) => {
    const user = c.get('user');
    const sessionId = c.req.param('sessionId');
    const db = c.env.DB;

    const { results: sessions } = await db.prepare(
      'SELECT id FROM user_sessions WHERE id = ? AND user_id = ?'
    ).bind(sessionId, user.user_id).all();

    if (sessions.length === 0) {
      return c.json({ error: 'Session not found' }, 404);
    }

    await db.prepare(
      'UPDATE user_sessions SET revoked_at = ? WHERE id = ?'
    ).bind(now(), sessionId).run();

    return c.json({ message: 'Session revoked' });
  });

  app.post('/sessions/revoke-all', authMiddleware, async (c) => {
    const user = c.get('user');
    const db = c.env.DB;
    const currentSession = c.get('session');

    await db.prepare(`
      UPDATE user_sessions
      SET revoked_at = ?
      WHERE user_id = ? AND revoked_at IS NULL AND id != ?
    `).bind(now(), user.user_id, currentSession?.id || '').run();

    return c.json({ message: 'All other sessions revoked' });
  });

  app.get('/admin/users/:userId/security-events', authMiddleware, adminMiddleware, async (c) => {
    const userId = c.req.param('userId');
    const db = c.env.DB;

    const { results: events } = await db.prepare(`
      SELECT * FROM session_security_events
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT 100
    `).bind(userId).all();

    return c.json({ events });
  });

  app.post('/admin/users/:userId/revoke-sessions', authMiddleware, adminMiddleware, async (c) => {
    const admin = c.get('user');
    const userId = c.req.param('userId');
    const db = c.env.DB;

    await db.prepare(`
      UPDATE user_sessions
      SET revoked_at = ?
      WHERE user_id = ? AND revoked_at IS NULL
    `).bind(now(), userId).run();

    await db.prepare(`
      INSERT INTO admin_logs (id, admin_id, action, target_id, target_type, details, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(generateId(), admin.user_id, 'revoke_all_sessions', userId, 'user', '{}', now()).run();

    return c.json({ message: 'All user sessions revoked' });
  });


  app.post('/admin/cleanup', authMiddleware, adminMiddleware, async (c) => {
    const db = c.env.DB;
    const currentTime = now();
    const results = {
      expired_sessions: 0,
      old_security_events: 0,
      expired_oauth_states: 0,
      expired_oauth_temp: 0,
      old_rate_limits: 0,
      expired_email_tokens: 0,
    };

    try {
      const thirtyDaysAgo = currentTime - (30 * 24 * 60 * 60);
      const expiredSessions = await db.prepare(
        'DELETE FROM user_sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)'
      ).bind(thirtyDaysAgo, thirtyDaysAgo).run();
      results.expired_sessions = expiredSessions.meta?.changes || 0;

      const ninetyDaysAgo = currentTime - (90 * 24 * 60 * 60);
      const oldEvents = await db.prepare(
        'DELETE FROM session_security_events WHERE created_at < ?'
      ).bind(ninetyDaysAgo).run();
      results.old_security_events = oldEvents.meta?.changes || 0;

      const oneHourAgo = currentTime - 3600;
      const expiredOauthStates = await db.prepare(
        'DELETE FROM oauth_states WHERE created_at < ?'
      ).bind(oneHourAgo).run();
      results.expired_oauth_states = expiredOauthStates.meta?.changes || 0;

      const expiredOauthTemp = await db.prepare(
        'DELETE FROM oauth_temp WHERE created_at < ?'
      ).bind(oneHourAgo).run();
      results.expired_oauth_temp = expiredOauthTemp.meta?.changes || 0;

      const oneDayAgo = currentTime - (24 * 60 * 60);
      const oldRateLimits = await db.prepare(
        'DELETE FROM mail_rate_limits WHERE timestamp < ?'
      ).bind(oneDayAgo).run();
      results.old_rate_limits = oldRateLimits.meta?.changes || 0;

      const expiredEmailTokens = await db.prepare(
        'DELETE FROM email_tokens WHERE expires_at < ?'
      ).bind(oneDayAgo).run();
      results.expired_email_tokens = expiredEmailTokens.meta?.changes || 0;

    } catch (e) {
      console.error('Cleanup error:', e);
      return c.json({ error: 'Cleanup failed', details: e.message }, 500);
    }

    return c.json({
      message: 'Cleanup completed',
      deleted: results,
      timestamp: currentTime,
    });
  });


  app.get('/kb/articles', async (c) => {
    const db = c.env.DB;
    const { search, category, page = '1', limit = '20' } = c.req.query();
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    const offset = (pageNum - 1) * limitNum;
    const where = ['is_published = 1'];
    const params = [];

    if (search) {
      where.push('(title LIKE ? OR content LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }

    if (category) {
      where.push('category = ?');
      params.push(category);
    }

    const { results: articles } = await db.prepare(`
      SELECT id, slug, title, category, tags, author_id, is_published, view_count,
             helpful_yes, helpful_no, created_at, updated_at, published_at
      FROM kb_articles
      WHERE ${where.join(' AND ')}
      ORDER BY published_at DESC, created_at DESC
      LIMIT ? OFFSET ?
    `).bind(...params, limitNum, offset).all();

    return c.json({ articles, page: pageNum, limit: limitNum });
  });

  app.get('/kb/articles/:slug', async (c) => {
    const db = c.env.DB;
    const slug = c.req.param('slug');

    const { results: articles } = await db.prepare(`
      SELECT id, slug, title, content, category, tags, author_id, is_published, view_count,
             helpful_yes, helpful_no, created_at, updated_at, published_at
      FROM kb_articles
      WHERE slug = ? AND is_published = 1
    `).bind(slug).all();

    if (articles.length === 0) {
      return c.json({ error: 'Article not found' }, 404);
    }

    const article = articles[0];
    await db.prepare('UPDATE kb_articles SET view_count = view_count + 1 WHERE id = ?')
      .bind(article.id).run();

    return c.json({ article: { ...article, view_count: article.view_count + 1 } });
  });

  app.post('/kb/articles/:id/feedback', async (c) => {
    const db = c.env.DB;
    const id = c.req.param('id');
    const body = await c.req.json();
    let helpful = body?.helpful;

    if (typeof helpful !== 'boolean') {
      if (body?.value === 'yes') helpful = true;
      if (body?.value === 'no') helpful = false;
    }

    if (typeof helpful !== 'boolean') {
      return c.json({ error: 'Invalid feedback payload' }, 400);
    }

    const field = helpful ? 'helpful_yes' : 'helpful_no';
    await db.prepare(`UPDATE kb_articles SET ${field} = ${field} + 1 WHERE id = ?`)
      .bind(id).run();

    return c.json({ message: 'Feedback recorded' });
  });

  app.get('/kb/categories', async (c) => {
    const db = c.env.DB;
    const { results: categories } = await db.prepare(`
      SELECT id, slug, name, description, icon, display_order
      FROM kb_categories
      WHERE is_active = 1
      ORDER BY display_order ASC, name ASC
    `).all();

    return c.json({ categories });
  });

  app.get('/kb/admin/articles', authMiddleware, adminMiddleware, async (c) => {
    const db = c.env.DB;
    const { search, category, published, page = '1', limit = '50' } = c.req.query();
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const offset = (pageNum - 1) * limitNum;
    const where = ['1 = 1'];
    const params = [];

    if (search) {
      where.push('(title LIKE ? OR content LIKE ? OR slug LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    if (category) {
      where.push('category = ?');
      params.push(category);
    }

    if (published === 'true' || published === '1') {
      where.push('is_published = 1');
    } else if (published === 'false' || published === '0') {
      where.push('is_published = 0');
    }

    const { results: articles } = await db.prepare(`
      SELECT id, slug, title, content, category, tags, author_id, is_published, view_count,
             helpful_yes, helpful_no, created_at, updated_at, published_at
      FROM kb_articles
      WHERE ${where.join(' AND ')}
      ORDER BY updated_at DESC
      LIMIT ? OFFSET ?
    `).bind(...params, limitNum, offset).all();

    return c.json({ articles, page: pageNum, limit: limitNum });
  });

  app.get('/kb/admin/articles/:id', authMiddleware, adminMiddleware, async (c) => {
    const db = c.env.DB;
    const id = c.req.param('id');

    const { results: articles } = await db.prepare(`
      SELECT id, slug, title, content, category, tags, author_id, is_published, view_count,
             helpful_yes, helpful_no, created_at, updated_at, published_at
      FROM kb_articles
      WHERE id = ?
    `).bind(id).all();

    if (articles.length === 0) {
      return c.json({ error: 'Article not found' }, 404);
    }

    return c.json({ article: articles[0] });
  });

  app.post('/kb/articles', authMiddleware, adminMiddleware, async (c) => {
    const admin = c.get('user');
    const db = c.env.DB;
    const body = await c.req.json();
    const title = body?.title?.trim();
    const content = body?.content?.trim();
    const category = body?.category?.trim();
    let slug = body?.slug?.trim();
    const tags = Array.isArray(body?.tags) ? JSON.stringify(body.tags) : (body?.tags ? JSON.stringify(body.tags) : null);
    const isPublished = Boolean(body?.is_published);

    if (!title || !content || !category) {
      return c.json({ error: 'Missing required fields' }, 400);
    }

    if (!slug) {
      slug = slugify(title);
    }

    const { results: existing } = await db.prepare(
      'SELECT id FROM kb_articles WHERE slug = ?'
    ).bind(slug).all();

    if (existing.length > 0) {
      return c.json({ error: 'Slug already in use' }, 409);
    }

    const articleId = generateId();
    const timestamp = now();
    const publishedAt = isPublished ? timestamp : null;

    await db.prepare(`
      INSERT INTO kb_articles (
        id, slug, title, content, category, tags, author_id,
        is_published, view_count, helpful_yes, helpful_no,
        created_at, updated_at, published_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?)
    `).bind(
      articleId,
      slug,
      title,
      content,
      category,
      tags,
      admin.user_id,
      isPublished ? 1 : 0,
      timestamp,
      timestamp,
      publishedAt
    ).run();

    return c.json({ id: articleId, slug });
  });

  app.put('/kb/articles/:id', authMiddleware, adminMiddleware, async (c) => {
    const db = c.env.DB;
    const id = c.req.param('id');
    const body = await c.req.json();

    const { results: existingRows } = await db.prepare(
      'SELECT id, slug, is_published, published_at FROM kb_articles WHERE id = ?'
    ).bind(id).all();

    if (existingRows.length === 0) {
      return c.json({ error: 'Article not found' }, 404);
    }

    const existing = existingRows[0];
    const updates = [];
    const params = [];
    const nowTs = now();

    if (body?.title) {
      updates.push('title = ?');
      params.push(body.title.trim());
    }

    if (body?.content) {
      updates.push('content = ?');
      params.push(body.content.trim());
    }

    if (body?.category) {
      updates.push('category = ?');
      params.push(body.category.trim());
    }

    if (body?.slug) {
      const newSlug = body.slug.trim();
      if (newSlug !== existing.slug) {
        const { results: slugRows } = await db.prepare(
          'SELECT id FROM kb_articles WHERE slug = ? AND id != ?'
        ).bind(newSlug, id).all();
        if (slugRows.length > 0) {
          return c.json({ error: 'Slug already in use' }, 409);
        }
        updates.push('slug = ?');
        params.push(newSlug);
      }
    }

    if (body?.tags !== undefined) {
      const tagValue = Array.isArray(body.tags) ? JSON.stringify(body.tags) : (body.tags ? JSON.stringify(body.tags) : null);
      updates.push('tags = ?');
      params.push(tagValue);
    }

    if (body?.is_published !== undefined) {
      const nextPublished = Boolean(body.is_published);
      updates.push('is_published = ?');
      params.push(nextPublished ? 1 : 0);

      if (nextPublished && !existing.is_published) {
        updates.push('published_at = ?');
        params.push(nowTs);
      } else if (!nextPublished) {
        updates.push('published_at = NULL');
      }
    }

    updates.push('updated_at = ?');
    params.push(nowTs);

    if (updates.length === 0) {
      return c.json({ message: 'No changes' });
    }

    await db.prepare(`UPDATE kb_articles SET ${updates.join(', ')} WHERE id = ?`)
      .bind(...params, id).run();

    return c.json({ message: 'Article updated' });
  });

  app.delete('/kb/articles/:id', authMiddleware, adminMiddleware, async (c) => {
    const db = c.env.DB;
    const id = c.req.param('id');

    await db.prepare('DELETE FROM kb_articles WHERE id = ?').bind(id).run();
    return c.json({ message: 'Article deleted' });
  });

  app.post('/support/tickets', authMiddleware, async (c) => {
    const user = c.get('user');
    const db = c.env.DB;
    const body = await c.req.json();
    const subject = body?.subject?.trim();
    const message = body?.message?.trim();
    let category = body?.category?.trim();
    const priority = body?.priority?.trim() || 'normal';
    const restriction = c.get('restricted_account');
    const allowedPriorities = ['low', 'normal', 'high', 'urgent'];

    if (!subject || !message) {
      return c.json({ error: 'Missing subject or message' }, 400);
    }

    if (!allowedPriorities.includes(priority)) {
      return c.json({ error: 'Invalid priority' }, 400);
    }

    if (restriction?.is_banned || restriction?.is_locked) {
      const { results: userRows } = await db.prepare(
        'SELECT is_banned, is_locked, banned_at, locked_at FROM users WHERE id = ?'
      ).bind(user.user_id).all();

      const userStatus = userRows[0] || {};
      if (userStatus.is_banned) {
        category = 'ban_appeal';
        const cutoff = userStatus.banned_at || 0;
        const { results: existingAppeals } = await db.prepare(`
          SELECT id FROM support_tickets
          WHERE user_id = ? AND category = ? AND created_at >= ?
          LIMIT 1
        `).bind(user.user_id, category, cutoff).all();

        if (existingAppeals.length > 0) {
          return c.json({ error: 'Appeal already submitted for this ban' }, 409);
        }
      } else if (userStatus.is_locked) {
        category = 'lock_appeal';
        const cutoff = userStatus.locked_at || 0;
        const { results: existingAppeals } = await db.prepare(`
          SELECT id FROM support_tickets
          WHERE user_id = ? AND category = ? AND created_at >= ?
          LIMIT 1
        `).bind(user.user_id, category, cutoff).all();

        if (existingAppeals.length > 0) {
          return c.json({ error: 'Appeal already submitted for this lock' }, 409);
        }
      }
    }

    if (!category) {
      return c.json({ error: 'Missing category' }, 400);
    }

    const { results: seqRows } = await db.prepare(
      'UPDATE ticket_sequence SET next_number = next_number + 1 WHERE id = 1 RETURNING next_number - 1 as ticket_number'
    ).all();

    let ticketNumber = seqRows[0]?.ticket_number;
    if (!ticketNumber) {
      await db.prepare(
        'INSERT OR IGNORE INTO ticket_sequence (id, next_number) VALUES (1, 1)'
      ).run();

      const { results: seqRowsRetry } = await db.prepare(
        'UPDATE ticket_sequence SET next_number = next_number + 1 WHERE id = 1 RETURNING next_number - 1 as ticket_number'
      ).all();
      ticketNumber = seqRowsRetry[0]?.ticket_number;
    }
    if (!ticketNumber) {
      return c.json({ error: 'Failed to allocate ticket number' }, 500);
    }

    const ticketId = generateId();
    const messageId = generateId();
    const timestamp = now();

    await db.prepare(`
      INSERT INTO support_tickets (
        id, ticket_number, user_id, subject, category, priority, status,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      ticketId,
      ticketNumber,
      user.user_id,
      subject,
      category,
      priority,
      'open',
      timestamp,
      timestamp
    ).run();

    await db.prepare(`
      INSERT INTO ticket_messages (
        id, ticket_id, author_id, content, is_staff_reply, is_internal_note, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      messageId,
      ticketId,
      user.user_id,
      message,
      0,
      0,
      timestamp
    ).run();

    // Notify admins who have new-ticket notifications enabled
    try {
      const { results: adminPrefs } = await db.prepare(`
        SELECT u.email, u.username_original
        FROM users u
        LEFT JOIN admin_notification_preferences anp ON anp.user_id = u.id
        WHERE u.role = 'admin'
          AND u.email IS NOT NULL
          AND (anp.notify_new_tickets IS NULL OR anp.notify_new_tickets = 1)
      `).all();

      await Promise.all(adminPrefs.map(admin =>
        fetch('https://api.brevo.com/v3/smtp/email', {
          method: 'POST',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'api-key': c.env.EMAIL_SERVICE_API_KEY,
          },
          body: JSON.stringify({
            sender: { name: 'QTI Support', email: 'auth@account.quietterminal.co.uk' },
            to: [{ email: admin.email }],
            subject: `New Support Ticket #${ticketNumber}: ${subject}`,
            htmlContent: `
              <!DOCTYPE html>
              <html>
              <head><meta charset="utf-8"></head>
              <body style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
                <h2 style="color: #1d4ed8;">New Support Ticket</h2>
                <div style="background: #f1f5f9; border: 1px solid #cbd5e1; padding: 16px; border-radius: 8px; margin: 20px 0;">
                  <p><strong>Ticket #:</strong> ${ticketNumber}</p>
                  <p><strong>Subject:</strong> ${subject}</p>
                  <p><strong>Category:</strong> ${category}</p>
                  <p><strong>Priority:</strong> ${priority}</p>
                  <p><strong>Submitted:</strong> ${new Date().toUTCString()}</p>
                </div>
                <p>Log in to the admin panel to view and respond to this ticket.</p>
                <p style="color: #6b7280; font-size: 12px; margin-top: 40px;">
                  You are receiving this because you are an admin with new-ticket notifications enabled.<br>
                  &copy; ${new Date().getFullYear()} Quiet Terminal Interactive
                </p>
              </body>
              </html>
            `,
          }),
        }).catch(e => console.error('Failed to send new-ticket notification to', admin.email, e))
      ));
    } catch (e) {
      console.error('Failed to send new-ticket admin notifications:', e);
    }

    return c.json({
      id: ticketId,
      ticket_number: ticketNumber,
      status: 'open',
    });
  });

  app.get('/support/tickets', authMiddleware, async (c) => {
    const user = c.get('user');
    const db = c.env.DB;
    const { status, search, page = '1', limit = '20' } = c.req.query();
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    const offset = (pageNum - 1) * limitNum;
    const where = ['user_id = ?'];
    const params = [user.user_id];

    if (status) {
      where.push('status = ?');
      params.push(status);
    }

    if (search) {
      where.push('(subject LIKE ? OR CAST(ticket_number AS TEXT) LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }

    const { results: tickets } = await db.prepare(`
      SELECT id, ticket_number, subject, category, priority, status, assigned_to,
             created_at, updated_at, resolved_at, closed_at, satisfaction_rating
      FROM support_tickets
      WHERE ${where.join(' AND ')}
      ORDER BY updated_at DESC
      LIMIT ? OFFSET ?
    `).bind(...params, limitNum, offset).all();

    return c.json({ tickets, page: pageNum, limit: limitNum });
  });

  app.get('/support/tickets/:id', authMiddleware, async (c) => {
    const user = c.get('user');
    const db = c.env.DB;
    const id = c.req.param('id');

    const { results: tickets } = await db.prepare(
      'SELECT * FROM support_tickets WHERE id = ? AND user_id = ?'
    ).bind(id, user.user_id).all();

    if (tickets.length === 0) {
      return c.json({ error: 'Ticket not found' }, 404);
    }

    const { results: messages } = await db.prepare(`
      SELECT id, ticket_id, author_id, content, is_staff_reply, is_internal_note, created_at, edited_at
      FROM ticket_messages
      WHERE ticket_id = ? AND is_internal_note = 0
      ORDER BY created_at ASC
    `).bind(id).all();

    return c.json({ ticket: tickets[0], messages });
  });

  app.post('/support/tickets/:id/reply', authMiddleware, async (c) => {
    const user = c.get('user');
    const db = c.env.DB;
    const id = c.req.param('id');
    const { message } = await c.req.json();

    if (!message?.trim()) {
      return c.json({ error: 'Message is required' }, 400);
    }

    const { results: tickets } = await db.prepare(
      'SELECT id, status FROM support_tickets WHERE id = ? AND user_id = ?'
    ).bind(id, user.user_id).all();

    if (tickets.length === 0) {
      return c.json({ error: 'Ticket not found' }, 404);
    }

    if (tickets[0].status === 'closed') {
      return c.json({ error: 'Ticket is closed' }, 400);
    }

    const timestamp = now();
    await db.prepare(`
      INSERT INTO ticket_messages (
        id, ticket_id, author_id, content, is_staff_reply, is_internal_note, created_at
      ) VALUES (?, ?, ?, ?, 0, 0, ?)
    `).bind(generateId(), id, user.user_id, message.trim(), timestamp).run();

    await db.prepare(
      'UPDATE support_tickets SET status = ?, updated_at = ? WHERE id = ?'
    ).bind('awaiting_reply', timestamp, id).run();

    return c.json({ message: 'Reply added' });
  });

  app.post('/support/tickets/:id/close', authMiddleware, async (c) => {
    const user = c.get('user');
    const db = c.env.DB;
    const id = c.req.param('id');
    const timestamp = now();

    const { results: tickets } = await db.prepare(
      'SELECT id, status FROM support_tickets WHERE id = ? AND user_id = ?'
    ).bind(id, user.user_id).all();

    if (tickets.length === 0) {
      return c.json({ error: 'Ticket not found' }, 404);
    }

    if (tickets[0].status === 'closed') {
      return c.json({ message: 'Ticket already closed' });
    }

    await db.prepare(`
      UPDATE support_tickets
      SET status = 'closed', closed_at = ?, updated_at = ?
      WHERE id = ?
    `).bind(timestamp, timestamp, id).run();

    return c.json({ message: 'Ticket closed' });
  });

  app.post('/support/tickets/:id/reopen', authMiddleware, async (c) => {
    const user = c.get('user');
    const db = c.env.DB;
    const id = c.req.param('id');
    const timestamp = now();

    const { results: tickets } = await db.prepare(
      'SELECT id, status FROM support_tickets WHERE id = ? AND user_id = ?'
    ).bind(id, user.user_id).all();

    if (tickets.length === 0) {
      return c.json({ error: 'Ticket not found' }, 404);
    }

    if (tickets[0].status !== 'closed') {
      return c.json({ error: 'Ticket is not closed' }, 400);
    }

    await db.prepare(`
      UPDATE support_tickets
      SET status = 'open', closed_at = NULL, resolved_at = NULL, updated_at = ?
      WHERE id = ?
    `).bind(timestamp, id).run();

    return c.json({ message: 'Ticket reopened' });
  });

  app.post('/support/tickets/:id/rate', authMiddleware, async (c) => {
    const user = c.get('user');
    const db = c.env.DB;
    const id = c.req.param('id');
    const { rating } = await c.req.json();
    const ratingValue = parseInt(rating, 10);

    if (!ratingValue || ratingValue < 1 || ratingValue > 5) {
      return c.json({ error: 'Rating must be between 1 and 5' }, 400);
    }

    const { results: tickets } = await db.prepare(
      'SELECT id, status FROM support_tickets WHERE id = ? AND user_id = ?'
    ).bind(id, user.user_id).all();

    if (tickets.length === 0) {
      return c.json({ error: 'Ticket not found' }, 404);
    }

    if (!['resolved', 'closed'].includes(tickets[0].status)) {
      return c.json({ error: 'Ticket is not resolved' }, 400);
    }

    await db.prepare(
      'UPDATE support_tickets SET satisfaction_rating = ?, updated_at = ? WHERE id = ?'
    ).bind(ratingValue, now(), id).run();

    return c.json({ message: 'Rating saved' });
  });

  app.get('/support/admin/tickets', authMiddleware, staffMiddleware, async (c) => {
    const db = c.env.DB;
    const { status, priority, category, assigned_to, search, page = '1', limit = '50' } = c.req.query();
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const offset = (pageNum - 1) * limitNum;
    const where = ['1 = 1'];
    const params = [];

    if (status) {
      where.push('t.status = ?');
      params.push(status);
    }

    if (priority) {
      where.push('t.priority = ?');
      params.push(priority);
    }

    if (category) {
      where.push('t.category = ?');
      params.push(category);
    }

    if (assigned_to) {
      where.push('t.assigned_to = ?');
      params.push(assigned_to);
    }

    if (search) {
      where.push('(t.subject LIKE ? OR CAST(t.ticket_number AS TEXT) LIKE ? OR u.username_original LIKE ? OR u.email LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }

    const { results: tickets } = await db.prepare(`
      SELECT t.*,
             u.username_original as user_username,
             u.email as user_email,
             a.username_original as assigned_username,
             a.email as assigned_email
      FROM support_tickets t
      LEFT JOIN users u ON t.user_id = u.id
      LEFT JOIN users a ON t.assigned_to = a.id
      WHERE ${where.join(' AND ')}
      ORDER BY t.updated_at DESC
      LIMIT ? OFFSET ?
    `).bind(...params, limitNum, offset).all();

    return c.json({ tickets, page: pageNum, limit: limitNum });
  });

  app.get('/support/admin/tickets/:id', authMiddleware, staffMiddleware, async (c) => {
    const db = c.env.DB;
    const id = c.req.param('id');

    const { results: tickets } = await db.prepare(`
      SELECT t.*,
             u.username_original as user_username,
             u.email as user_email,
             a.username_original as assigned_username,
             a.email as assigned_email
      FROM support_tickets t
      LEFT JOIN users u ON t.user_id = u.id
      LEFT JOIN users a ON t.assigned_to = a.id
      WHERE t.id = ?
    `).bind(id).all();

    if (tickets.length === 0) {
      return c.json({ error: 'Ticket not found' }, 404);
    }

    const { results: messages } = await db.prepare(`
      SELECT id, ticket_id, author_id, content, is_staff_reply, is_internal_note, created_at, edited_at
      FROM ticket_messages
      WHERE ticket_id = ?
      ORDER BY created_at ASC
    `).bind(id).all();

    return c.json({ ticket: tickets[0], messages });
  });

  app.post('/support/admin/tickets/:id/reply', authMiddleware, staffMiddleware, async (c) => {
    const staff = c.get('user');
    const db = c.env.DB;
    const id = c.req.param('id');
    const { message } = await c.req.json();

    if (!message?.trim()) {
      return c.json({ error: 'Message is required' }, 400);
    }

    const { results: tickets } = await db.prepare(
      'SELECT id, ticket_number, subject, user_id FROM support_tickets WHERE id = ?'
    ).bind(id).all();

    if (tickets.length === 0) {
      return c.json({ error: 'Ticket not found' }, 404);
    }

    const ticket = tickets[0];
    const timestamp = now();
    await db.prepare(`
      INSERT INTO ticket_messages (
        id, ticket_id, author_id, content, is_staff_reply, is_internal_note, created_at
      ) VALUES (?, ?, ?, ?, 1, 0, ?)
    `).bind(generateId(), id, staff.user_id, message.trim(), timestamp).run();

    await db.prepare(
      'UPDATE support_tickets SET status = ?, updated_at = ? WHERE id = ?'
    ).bind('in_progress', timestamp, id).run();

    // Notify ticket owner if they have email and notifications enabled
    try {
      const { results: owners } = await db.prepare(`
        SELECT u.email, u.username_original
        FROM users u
        LEFT JOIN user_notification_preferences unp ON unp.user_id = u.id
        WHERE u.id = ?
          AND u.email IS NOT NULL
          AND u.oauth_provider IS NULL
          AND (unp.notify_ticket_updates IS NULL OR unp.notify_ticket_updates = 1)
      `).bind(ticket.user_id).all();

      if (owners.length > 0) {
        const owner = owners[0];
        await fetch('https://api.brevo.com/v3/smtp/email', {
          method: 'POST',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'api-key': c.env.EMAIL_SERVICE_API_KEY,
          },
          body: JSON.stringify({
            sender: { name: 'QTI Support', email: 'auth@account.quietterminal.co.uk' },
            to: [{ email: owner.email }],
            subject: `Re: Support Ticket #${ticket.ticket_number} — ${ticket.subject}`,
            htmlContent: `
              <!DOCTYPE html>
              <html>
              <head><meta charset="utf-8"></head>
              <body style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
                <h2 style="color: #1d4ed8;">A staff member has replied to your ticket</h2>
                <div style="background: #f1f5f9; border: 1px solid #cbd5e1; padding: 16px; border-radius: 8px; margin: 20px 0;">
                  <p><strong>Ticket #${ticket.ticket_number}:</strong> ${ticket.subject}</p>
                </div>
                <p>Log in to your account to view the full reply and respond.</p>
                <p style="color: #6b7280; font-size: 12px; margin-top: 40px;">
                  You are receiving this because you have ticket update notifications enabled.<br>
                  You can manage this preference in your account settings.<br>
                  &copy; ${new Date().getFullYear()} Quiet Terminal Interactive
                </p>
              </body>
              </html>
            `,
          }),
        });
      }
    } catch (e) {
      console.error('Failed to send ticket reply notification:', e);
    }

    return c.json({ message: 'Reply added' });
  });

  app.post('/support/admin/tickets/:id/note', authMiddleware, staffMiddleware, async (c) => {
    const staff = c.get('user');
    const db = c.env.DB;
    const id = c.req.param('id');
    const { message } = await c.req.json();

    if (!message?.trim()) {
      return c.json({ error: 'Note is required' }, 400);
    }

    const { results: tickets } = await db.prepare(
      'SELECT id FROM support_tickets WHERE id = ?'
    ).bind(id).all();

    if (tickets.length === 0) {
      return c.json({ error: 'Ticket not found' }, 404);
    }

    await db.prepare(`
      INSERT INTO ticket_messages (
        id, ticket_id, author_id, content, is_staff_reply, is_internal_note, created_at
      ) VALUES (?, ?, ?, ?, 1, 1, ?)
    `).bind(generateId(), id, staff.user_id, message.trim(), now()).run();

    return c.json({ message: 'Note added' });
  });

  app.put('/support/admin/tickets/:id/assign', authMiddleware, staffMiddleware, async (c) => {
    const db = c.env.DB;
    const id = c.req.param('id');
    const { assigned_to } = await c.req.json();
    const timestamp = now();

    if (assigned_to) {
      const { results: users } = await db.prepare(
        'SELECT id FROM users WHERE id = ?'
      ).bind(assigned_to).all();
      if (users.length === 0) {
        return c.json({ error: 'Assigned user not found' }, 404);
      }
    }

    await db.prepare(
      'UPDATE support_tickets SET assigned_to = ?, updated_at = ? WHERE id = ?'
    ).bind(assigned_to || null, timestamp, id).run();

    return c.json({ message: 'Assignment updated' });
  });

  app.put('/support/admin/tickets/:id/status', authMiddleware, staffMiddleware, async (c) => {
    const db = c.env.DB;
    const id = c.req.param('id');
    const { status } = await c.req.json();
    const allowedStatuses = ['open', 'awaiting_reply', 'in_progress', 'resolved', 'closed'];

    if (!allowedStatuses.includes(status)) {
      return c.json({ error: 'Invalid status' }, 400);
    }

    const { results: tickets } = await db.prepare(
      'SELECT ticket_number, subject, user_id FROM support_tickets WHERE id = ?'
    ).bind(id).all();

    if (tickets.length === 0) {
      return c.json({ error: 'Ticket not found' }, 404);
    }

    const ticket = tickets[0];
    const timestamp = now();
    const updates = ['status = ?', 'updated_at = ?'];
    const params = [status, timestamp];

    if (status === 'resolved') {
      updates.push('resolved_at = ?');
      params.push(timestamp);
      updates.push('closed_at = NULL');
    } else if (status === 'closed') {
      updates.push('closed_at = ?');
      params.push(timestamp);
      updates.push('resolved_at = NULL');
    } else {
      updates.push('resolved_at = NULL', 'closed_at = NULL');
    }

    params.push(id);
    await db.prepare(`UPDATE support_tickets SET ${updates.join(', ')} WHERE id = ?`)
      .bind(...params).run();

    const STATUS_LABELS = {
      open: 'Open',
      awaiting_reply: 'Awaiting Your Reply',
      in_progress: 'In Progress',
      resolved: 'Resolved',
      closed: 'Closed',
    };

    // Notify ticket owner of status change
    try {
      const { results: owners } = await db.prepare(`
        SELECT u.email, u.username_original
        FROM users u
        LEFT JOIN user_notification_preferences unp ON unp.user_id = u.id
        WHERE u.id = ?
          AND u.email IS NOT NULL
          AND u.oauth_provider IS NULL
          AND (unp.notify_ticket_updates IS NULL OR unp.notify_ticket_updates = 1)
      `).bind(ticket.user_id).all();

      if (owners.length > 0) {
        const owner = owners[0];
        await fetch('https://api.brevo.com/v3/smtp/email', {
          method: 'POST',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'api-key': c.env.EMAIL_SERVICE_API_KEY,
          },
          body: JSON.stringify({
            sender: { name: 'QTI Support', email: 'auth@account.quietterminal.co.uk' },
            to: [{ email: owner.email }],
            subject: `Ticket #${ticket.ticket_number} status updated — ${ticket.subject}`,
            htmlContent: `
              <!DOCTYPE html>
              <html>
              <head><meta charset="utf-8"></head>
              <body style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
                <h2 style="color: #1d4ed8;">Your support ticket status has been updated</h2>
                <div style="background: #f1f5f9; border: 1px solid #cbd5e1; padding: 16px; border-radius: 8px; margin: 20px 0;">
                  <p><strong>Ticket #${ticket.ticket_number}:</strong> ${ticket.subject}</p>
                  <p><strong>New status:</strong> ${STATUS_LABELS[status] || status}</p>
                </div>
                <p>Log in to your account to view your ticket.</p>
                <p style="color: #6b7280; font-size: 12px; margin-top: 40px;">
                  You are receiving this because you have ticket update notifications enabled.<br>
                  You can manage this preference in your account settings.<br>
                  &copy; ${new Date().getFullYear()} Quiet Terminal Interactive
                </p>
              </body>
              </html>
            `,
          }),
        });
      }
    } catch (e) {
      console.error('Failed to send ticket status notification:', e);
    }

    return c.json({ message: 'Status updated' });
  });

  app.put('/support/admin/tickets/:id/priority', authMiddleware, staffMiddleware, async (c) => {
    const db = c.env.DB;
    const id = c.req.param('id');
    const { priority } = await c.req.json();
    const allowedPriorities = ['low', 'normal', 'high', 'urgent'];

    if (!allowedPriorities.includes(priority)) {
      return c.json({ error: 'Invalid priority' }, 400);
    }

    await db.prepare(
      'UPDATE support_tickets SET priority = ?, updated_at = ? WHERE id = ?'
    ).bind(priority, now(), id).run();

    return c.json({ message: 'Priority updated' });
  });

  app.get('/support/admin/stats', authMiddleware, staffMiddleware, async (c) => {
    const db = c.env.DB;
    const { results: statsRows } = await db.prepare(`
      SELECT
        SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) as open,
        SUM(CASE WHEN status = 'awaiting_reply' THEN 1 ELSE 0 END) as awaiting_reply,
        SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress,
        SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) as resolved,
        SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) as closed,
        SUM(CASE WHEN priority = 'urgent' THEN 1 ELSE 0 END) as urgent,
        SUM(CASE WHEN assigned_to IS NULL THEN 1 ELSE 0 END) as unassigned
      FROM support_tickets
    `).all();

    return c.json({ stats: statsRows[0] || {} });
  });


  app.get('/games', authMiddleware, async (c) => {
    const user = c.get('user');
    const db = c.env.DB;

    const whereClause = user.role === 'admin'
      ? 'WHERE is_active = 1'
      : 'WHERE is_active = 1 AND (admin_only IS NULL OR admin_only = 0)';

    const { results: games } = await db.prepare(
      `SELECT id, name, slug, description, icon_url, is_active FROM games ${whereClause} ORDER BY name`
    ).all();

    return c.json({ games });
  });

  app.get('/games/:gameSlug/stats', authMiddleware, async (c) => {
    const user = c.get('user');
    const gameSlug = c.req.param('gameSlug');
    const db = c.env.DB;

    const { results: games } = await db.prepare(
      'SELECT * FROM games WHERE slug = ? AND is_active = 1'
    ).bind(gameSlug).all();

    if (games.length === 0) {
      return c.json({ error: 'Game not found' }, 404);
    }

    const game = games[0];

    if (game.admin_only && user.role !== 'admin') {
      return c.json({ error: 'Forbidden: This game is only accessible to admins' }, 403);
    }

    const { results: achievements } = await db.prepare(`
      SELECT
        a.id, a.name, a.description, a.icon_url, a.points,
        ua.unlocked_at,
        CASE WHEN ua.id IS NOT NULL THEN 1 ELSE 0 END as unlocked
      FROM game_achievements a
      LEFT JOIN user_achievements ua ON a.id = ua.achievement_id AND ua.user_id = ?
      WHERE a.game_id = ?
      ORDER BY a.points DESC, a.name
    `).bind(user.user_id, game.id).all();

    const { results: stats } = await db.prepare(
      'SELECT * FROM user_game_stats WHERE user_id = ? AND game_id = ?'
    ).bind(user.user_id, game.id).all();

    const userStats = stats.length > 0 ? JSON.parse(stats[0].stats_data || '{}') : {};

    const totalAchievements = achievements.length;
    const unlockedAchievements = achievements.filter(a => a.unlocked).length;
    const totalPoints = achievements.reduce((sum, a) => sum + a.points, 0);
    const earnedPoints = achievements.filter(a => a.unlocked).reduce((sum, a) => sum + a.points, 0);

    return c.json({
      game,
      achievements,
      stats: userStats,
      progress: {
        total_achievements: totalAchievements,
        unlocked_achievements: unlockedAchievements,
        total_points: totalPoints,
        earned_points: earnedPoints,
        completion_percentage: totalAchievements > 0 ? Math.round((unlockedAchievements / totalAchievements) * 100) : 0
      }
    });
  });

  app.post('/admin/games', authMiddleware, adminMiddleware, async (c) => {
    const { name, slug, description, icon_url } = await c.req.json();
    const db = c.env.DB;

    const gameId = generateId();

    await db.prepare(`
      INSERT INTO games (id, name, slug, description, icon_url, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)
    `).bind(gameId, name, slug, description, icon_url || null, now(), now()).run();

    return c.json({ game_id: gameId, message: 'Game created' });
  });

  app.post('/admin/games/:gameSlug/achievements', authMiddleware, adminMiddleware, async (c) => {
    const gameSlug = c.req.param('gameSlug');
    const { name, description, icon_url, points } = await c.req.json();
    const db = c.env.DB;

    const { results: games } = await db.prepare(
      'SELECT id FROM games WHERE slug = ?'
    ).bind(gameSlug).all();

    if (games.length === 0) {
      return c.json({ error: 'Game not found' }, 404);
    }

    const achievementId = generateId();

    await db.prepare(`
      INSERT INTO game_achievements (id, game_id, name, description, icon_url, points, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(achievementId, games[0].id, name, description, icon_url || null, points || 10, now()).run();

    return c.json({ achievement_id: achievementId, message: 'Achievement created' });
  });

  // Return all active games owned by the authenticated user.
  app.get('/games/owned', authMiddleware, async (c) => {
    try {
      const db = c.env.DB;
      const user = c.get('user');
      const { results } = await db.prepare(`
        SELECT g.id, g.name, g.slug, g.description, g.icon_url, go.granted_at
        FROM games_owned go
        JOIN games g ON g.id = go.game_id
        WHERE go.user_id = ? AND g.is_active = 1
        ORDER BY g.name
      `).bind(user.user_id).all();
      return c.json({ games: results });
    } catch (error) {
      console.error('Error fetching owned games:', error);
      return c.json({ error: 'Failed to retrieve owned games' }, 500);
    }
  });

  // Check whether the authenticated user owns a specific game.
  app.get('/games/:gameSlug/owned', authMiddleware, async (c) => {
    const db = c.env.DB;
    const user = c.get('user');
    const gameSlug = c.req.param('gameSlug');
    const row = await db.prepare(`
      SELECT go.id FROM games_owned go
      JOIN games g ON g.id = go.game_id
      WHERE go.user_id = ? AND g.slug = ? AND g.is_active = 1
    `).bind(user.user_id, gameSlug).first();
    return c.json({ owned: !!row });
  });


  app.post('/jagsmp/generate-code', async (c) => {
    const { plugin_secret, minecraft_uuid, minecraft_username } = await c.req.json();
    const db = c.env.DB;

    if (plugin_secret !== c.env.MINECRAFT_PLUGIN_SECRET) {
      return c.json({ error: 'Invalid plugin secret' }, 401);
    }

    if (!minecraft_uuid || !minecraft_username) {
      return c.json({ error: 'minecraft_uuid and minecraft_username are required' }, 400);
    }

    const code = generateLinkCode();
    const codeId = generateId();
    const now_ts = now();
    // Short TTL keeps leaked link codes low value.
    const expiresAt = now_ts + (10 * 60);

    const { results: existingLinks } = await db.prepare(
      'SELECT user_id FROM minecraft_accounts WHERE minecraft_uuid = ?'
    ).bind(minecraft_uuid).all();

    if (existingLinks.length > 0) {
      return c.json({ error: 'This Minecraft account is already linked', already_linked: true }, 400);
    }

    const { results: existingCodes } = await db.prepare(
      'SELECT id FROM minecraft_link_codes WHERE minecraft_uuid = ? AND used = 0 AND expires_at > ?'
    ).bind(minecraft_uuid, now_ts).all();

    if (existingCodes.length > 0) {
      await db.prepare('DELETE FROM minecraft_link_codes WHERE minecraft_uuid = ?').bind(minecraft_uuid).run();
    }

    await db.prepare(`
      INSERT INTO minecraft_link_codes (id, code, minecraft_uuid, minecraft_username, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(codeId, code, minecraft_uuid, minecraft_username, now_ts, expiresAt).run();

    return c.json({
      code,
      expires_in_seconds: 600,
      message: 'Enter this code on the website to link your account'
    });
  });

  app.post('/jagsmp/link', authMiddleware, async (c) => {
    const { code } = await c.req.json();
    const db = c.env.DB;
    const user = c.get('user');
    const userId = user.user_id;
    const now_ts = now();

    if (!code) {
      return c.json({ error: 'Code is required' }, 400);
    }

    const { results: userLinks } = await db.prepare(
      'SELECT minecraft_uuid, minecraft_username FROM minecraft_accounts WHERE user_id = ?'
    ).bind(userId).all();

    if (userLinks.length > 0) {
      return c.json({
        error: 'You already have a linked Minecraft account',
        linked_account: {
          minecraft_username: userLinks[0].minecraft_username,
          minecraft_uuid: userLinks[0].minecraft_uuid
        }
      }, 400);
    }

    const { results: cooldowns } = await db.prepare(
      'SELECT can_link_again_at FROM minecraft_unlink_cooldowns WHERE user_id = ? AND can_link_again_at > ?'
    ).bind(userId, now_ts).all();

    if (cooldowns.length > 0) {
      const cooldownEnds = cooldowns[0].can_link_again_at;
      const remainingSeconds = cooldownEnds - now_ts;
      const remainingDays = Math.ceil(remainingSeconds / (24 * 60 * 60));
      return c.json({
        error: 'You cannot link a new account yet due to cooldown',
        cooldown_ends_at: cooldownEnds,
        remaining_days: remainingDays
      }, 429);
    }

    const { results: codes } = await db.prepare(
      'SELECT id, minecraft_uuid, minecraft_username, expires_at, used FROM minecraft_link_codes WHERE code = ?'
    ).bind(code.toUpperCase()).all();

    if (codes.length === 0) {
      return c.json({ error: 'Invalid code' }, 404);
    }

    const linkCode = codes[0];

    if (linkCode.used === 1) {
      return c.json({ error: 'This code has already been used' }, 400);
    }

    if (linkCode.expires_at < now_ts) {
      return c.json({ error: 'This code has expired' }, 400);
    }

    const { results: existingLinks } = await db.prepare(
      'SELECT user_id FROM minecraft_accounts WHERE minecraft_uuid = ?'
    ).bind(linkCode.minecraft_uuid).all();

    if (existingLinks.length > 0) {
      return c.json({ error: 'This Minecraft account is already linked to another user' }, 400);
    }

    const linkId = generateId();
    await db.prepare(`
      INSERT INTO minecraft_accounts (id, user_id, minecraft_uuid, minecraft_username, linked_at, last_updated)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(linkId, userId, linkCode.minecraft_uuid, linkCode.minecraft_username, now_ts, now_ts).run();

    await db.prepare(
      'UPDATE minecraft_link_codes SET used = 1, used_by_user_id = ?, used_at = ? WHERE id = ?'
    ).bind(userId, now_ts, linkCode.id).run();

    const statsId = generateId();
    await db.prepare(`
      INSERT INTO minecraft_player_stats (id, minecraft_uuid, first_joined, last_updated)
      VALUES (?, ?, ?, ?)
    `).bind(statsId, linkCode.minecraft_uuid, now_ts, now_ts).run();

    const activityId = generateId();
    await db.prepare(`
      INSERT INTO minecraft_activity_log (id, minecraft_uuid, activity_type, activity_data, occurred_at)
      VALUES (?, ?, 'account_linked', '{}', ?)
    `).bind(activityId, linkCode.minecraft_uuid, now_ts).run();

    return c.json({
      message: 'Minecraft account linked successfully',
      minecraft_username: linkCode.minecraft_username,
      minecraft_uuid: linkCode.minecraft_uuid
    });
  });

  app.post('/jagsmp/unlink', authMiddleware, async (c) => {
    const db = c.env.DB;
    const user = c.get('user');
    const userId = user.user_id;
    const now_ts = now();

    const { results: links } = await db.prepare(
      'SELECT minecraft_uuid, minecraft_username FROM minecraft_accounts WHERE user_id = ?'
    ).bind(userId).all();

    if (links.length === 0) {
      return c.json({ error: 'No linked Minecraft account found' }, 404);
    }

    const link = links[0];

    const cooldownId = generateId();
    // Cooldown prevents account churn abuse.
    const canLinkAgainAt = now_ts + (7 * 24 * 60 * 60);

    await db.prepare(`
      INSERT INTO minecraft_unlink_cooldowns (id, user_id, unlinked_at, can_link_again_at, previous_minecraft_uuid, previous_minecraft_username)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(cooldownId, userId, now_ts, canLinkAgainAt, link.minecraft_uuid, link.minecraft_username).run();

    await db.prepare('DELETE FROM minecraft_accounts WHERE user_id = ?').bind(userId).run();

    return c.json({
      message: 'Minecraft account unlinked successfully',
      cooldown_ends_at: canLinkAgainAt,
      can_link_again_in_days: 7
    });
  });

  app.get('/jagsmp/me', authMiddleware, async (c) => {
    const db = c.env.DB;
    const user = c.get('user');
    const userId = user.user_id;

    const { results: links } = await db.prepare(`
      SELECT minecraft_uuid, minecraft_username, linked_at, last_updated
      FROM minecraft_accounts
      WHERE user_id = ?
    `).bind(userId).all();

    if (links.length === 0) {
      return c.json({ linked: false, account: null });
    }

    const link = links[0];

    const { results: stats } = await db.prepare(`
      SELECT * FROM minecraft_player_stats WHERE minecraft_uuid = ?
    `).bind(link.minecraft_uuid).all();

    const { results: achievements } = await db.prepare(`
      SELECT ma.*, mpa.unlocked_at
      FROM minecraft_player_achievements mpa
      JOIN minecraft_achievements ma ON mpa.achievement_id = ma.id
      WHERE mpa.minecraft_uuid = ?
      ORDER BY mpa.unlocked_at DESC
    `).bind(link.minecraft_uuid).all();

    const { results: activity } = await db.prepare(`
      SELECT activity_type, activity_data, occurred_at
      FROM minecraft_activity_log
      WHERE minecraft_uuid = ?
      ORDER BY occurred_at DESC
      LIMIT 20
    `).bind(link.minecraft_uuid).all();

    const playerStats = stats[0] || {};
    const kills = playerStats.player_kills || 0;
    const deaths = playerStats.deaths || 0;
    const kdr = deaths > 0 ? (kills / deaths).toFixed(2) : kills.toFixed(2);

    const totalPoints = achievements.reduce((sum, ach) => sum + (ach.points || 0), 0);

    return c.json({
      linked: true,
      account: {
        minecraft_username: link.minecraft_username,
        minecraft_uuid: link.minecraft_uuid,
        linked_at: link.linked_at,
        last_updated: link.last_updated
      },
      stats: {
        playtime_hours: Math.floor((playerStats.total_playtime_minutes || 0) / 60),
        playtime_minutes: (playerStats.total_playtime_minutes || 0) % 60,
        total_playtime_minutes: playerStats.total_playtime_minutes || 0,
        first_joined: playerStats.first_joined,
        last_seen: playerStats.last_seen,
        total_sessions: playerStats.total_sessions || 0,
        player_kills: kills,
        deaths: deaths,
        kdr: parseFloat(kdr),
        mob_kills: playerStats.mob_kills || 0,
        damage_dealt: playerStats.damage_dealt || 0,
        damage_taken: playerStats.damage_taken || 0,
        damage_blocked_by_shield: playerStats.damage_blocked_by_shield || 0,
        damage_resisted: playerStats.damage_resisted || 0,
        damage_absorbed: playerStats.damage_absorbed || 0,
        movement: {
          distance_walked: playerStats.distance_walked || 0,
          distance_sprinted: playerStats.distance_sprinted || 0,
          distance_crouched: playerStats.distance_crouched || 0,
          distance_flown: playerStats.distance_flown || 0,
          distance_climbed: playerStats.distance_climbed || 0,
          distance_fallen: playerStats.distance_fallen || 0,
          distance_swam: playerStats.distance_swam || 0,
          distance_minecart: playerStats.distance_minecart || 0,
          distance_boat: playerStats.distance_boat || 0,
          distance_pig: playerStats.distance_pig || 0,
          distance_horse: playerStats.distance_horse || 0,
          distance_elytra: playerStats.distance_elytra || 0,
          jumps: playerStats.jumps || 0
        },
        interactions: {
          times_slept: playerStats.times_slept || 0,
          barrels_opened: playerStats.barrels_opened || 0,
          ender_chests_opened: playerStats.ender_chests_opened || 0,
          items_enchanted: playerStats.items_enchanted || 0,
          animals_bred: playerStats.animals_bred || 0,
          fish_caught: playerStats.fish_caught || 0,
          traded_with_villager: playerStats.traded_with_villager || 0,
          talked_to_villager: playerStats.talked_to_villager || 0,
          cake_slices_eaten: playerStats.cake_slices_eaten || 0,
          bells_rung: playerStats.bells_rung || 0
        },
        building: {
          items_crafted: playerStats.items_crafted || 0,
          beacons_interacted: playerStats.beacons_interacted || 0,
          anvils_used: playerStats.anvils_used || 0,
          lecterns_interacted: playerStats.lecterns_interacted || 0,
          grindstones_interacted: playerStats.grindstones_interacted || 0,
          looms_interacted: playerStats.looms_interacted || 0,
          smithing_tables_interacted: playerStats.smithing_tables_interacted || 0,
          stonecutters_interacted: playerStats.stonecutters_interacted || 0
        },
        misc: {
          raids_triggered: playerStats.raids_triggered || 0,
          raids_won: playerStats.raids_won || 0,
          targets_hit: playerStats.targets_hit || 0,
          time_since_rest: playerStats.time_since_rest || 0,
          time_since_death: playerStats.time_since_death || 0,
          flower_potted: playerStats.flower_potted || 0,
          armor_pieces_cleaned: playerStats.armor_pieces_cleaned || 0,
          banners_cleaned: playerStats.banners_cleaned || 0
        },
        current_session: {
          session_duration_seconds: playerStats.session_duration_seconds || 0,
          login_timestamp: playerStats.login_timestamp || 0
        },
        additional_stats: playerStats.stats_json ? JSON.parse(playerStats.stats_json) : {}
      },
      achievements: {
        total_unlocked: achievements.length,
        total_points: totalPoints,
        recent: achievements.slice(0, 5)
      },
      recent_activity: activity
    });
  });

  app.get('/jagsmp/achievements', async (c) => {
    const db = c.env.DB;

    const { results: achievements } = await db.prepare(`
      SELECT * FROM minecraft_achievements
      WHERE is_secret = 0
      ORDER BY category, points ASC
    `).all();

    const grouped = achievements.reduce((acc, ach) => {
      const category = ach.category || 'general';
      if (!acc[category]) acc[category] = [];
      acc[category].push(ach);
      return acc;
    }, {});

    return c.json({ achievements: grouped });
  });

  app.post('/jagsmp/plugin/update-stats', async (c) => {
    const { plugin_secret, minecraft_uuid, stats } = await c.req.json();
    const db = c.env.DB;

    if (plugin_secret !== c.env.MINECRAFT_PLUGIN_SECRET) {
      return c.json({ error: 'Invalid plugin secret' }, 401);
    }

    if (!minecraft_uuid || !stats) {
      return c.json({ error: 'minecraft_uuid and stats are required' }, 400);
    }

    const now_ts = now();

    const { results: existing } = await db.prepare(
      'SELECT id FROM minecraft_player_stats WHERE minecraft_uuid = ?'
    ).bind(minecraft_uuid).all();

    if (existing.length > 0) {
      await db.prepare(`
        UPDATE minecraft_player_stats
        SET total_playtime_minutes = ?,
            last_seen = ?,
            total_sessions = ?,
            player_kills = ?,
            deaths = ?,
            mob_kills = ?,
            damage_dealt = ?,
            damage_taken = ?,
            damage_blocked_by_shield = ?,
            damage_resisted = ?,
            damage_absorbed = ?,
            distance_walked = ?,
            distance_sprinted = ?,
            distance_crouched = ?,
            distance_flown = ?,
            distance_climbed = ?,
            distance_fallen = ?,
            distance_swam = ?,
            distance_minecart = ?,
            distance_boat = ?,
            distance_pig = ?,
            distance_horse = ?,
            distance_elytra = ?,
            jumps = ?,
            times_slept = ?,
            barrels_opened = ?,
            ender_chests_opened = ?,
            items_enchanted = ?,
            animals_bred = ?,
            fish_caught = ?,
            traded_with_villager = ?,
            talked_to_villager = ?,
            cake_slices_eaten = ?,
            bells_rung = ?,
            items_crafted = ?,
            beacons_interacted = ?,
            anvils_used = ?,
            lecterns_interacted = ?,
            grindstones_interacted = ?,
            looms_interacted = ?,
            smithing_tables_interacted = ?,
            stonecutters_interacted = ?,
            raids_triggered = ?,
            raids_won = ?,
            targets_hit = ?,
            time_since_rest = ?,
            time_since_death = ?,
            flower_potted = ?,
            armor_pieces_cleaned = ?,
            banners_cleaned = ?,
            session_duration_seconds = ?,
            login_timestamp = ?,
            stats_json = ?,
            last_updated = ?
        WHERE minecraft_uuid = ?
      `).bind(
        stats.total_playtime_minutes || 0,
        now_ts,
        stats.total_sessions || 0,
        stats.player_kills || 0,
        stats.deaths || 0,
        stats.mob_kills || 0,
        stats.damage_dealt || 0,
        stats.damage_taken || 0,
        stats.damage_blocked_by_shield || 0,
        stats.damage_resisted || 0,
        stats.damage_absorbed || 0,
        stats.movement?.distance_walked || 0,
        stats.movement?.distance_sprinted || 0,
        stats.movement?.distance_crouched || 0,
        stats.movement?.distance_flown || 0,
        stats.movement?.distance_climbed || 0,
        stats.movement?.distance_fallen || 0,
        stats.movement?.distance_swam || 0,
        stats.movement?.distance_minecart || 0,
        stats.movement?.distance_boat || 0,
        stats.movement?.distance_pig || 0,
        stats.movement?.distance_horse || 0,
        stats.movement?.distance_elytra || 0,
        stats.movement?.jumps || 0,
        stats.interactions?.times_slept || 0,
        stats.interactions?.barrels_opened || 0,
        stats.interactions?.ender_chests_opened || 0,
        stats.interactions?.items_enchanted || 0,
        stats.interactions?.animals_bred || 0,
        stats.interactions?.fish_caught || 0,
        stats.interactions?.traded_with_villager || 0,
        stats.interactions?.talked_to_villager || 0,
        stats.interactions?.cake_slices_eaten || 0,
        stats.interactions?.bells_rung || 0,
        stats.building?.items_crafted || 0,
        stats.building?.beacons_interacted || 0,
        stats.building?.anvils_used || 0,
        stats.building?.lecterns_interacted || 0,
        stats.building?.grindstones_interacted || 0,
        stats.building?.looms_interacted || 0,
        stats.building?.smithing_tables_interacted || 0,
        stats.building?.stonecutters_interacted || 0,
        stats.misc?.raids_triggered || 0,
        stats.misc?.raids_won || 0,
        stats.misc?.targets_hit || 0,
        stats.misc?.time_since_rest || 0,
        stats.misc?.time_since_death || 0,
        stats.misc?.flower_potted || 0,
        stats.misc?.armor_pieces_cleaned || 0,
        stats.misc?.banners_cleaned || 0,
        stats.current_session?.session_duration_seconds || 0,
        stats.current_session?.login_timestamp || 0,
        JSON.stringify(stats.additional || {}),
        now_ts,
        minecraft_uuid
      ).run();
    } else {
      const statsId = generateId();
      await db.prepare(`
        INSERT INTO minecraft_player_stats (
          id, minecraft_uuid, total_playtime_minutes, first_joined, last_seen,
          total_sessions, player_kills, deaths, mob_kills, damage_dealt, damage_taken,
          damage_blocked_by_shield, damage_resisted, damage_absorbed,
          distance_walked, distance_sprinted, distance_crouched, distance_flown,
          distance_climbed, distance_fallen, distance_swam, distance_minecart,
          distance_boat, distance_pig, distance_horse, distance_elytra, jumps,
          times_slept, barrels_opened, ender_chests_opened, items_enchanted,
          animals_bred, fish_caught, traded_with_villager, talked_to_villager,
          cake_slices_eaten, bells_rung, items_crafted, beacons_interacted,
          anvils_used, lecterns_interacted, grindstones_interacted, looms_interacted,
          smithing_tables_interacted, stonecutters_interacted, raids_triggered,
          raids_won, targets_hit, time_since_rest, time_since_death, flower_potted,
          armor_pieces_cleaned, banners_cleaned, session_duration_seconds,
          login_timestamp, stats_json, last_updated
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        statsId,
        minecraft_uuid,
        stats.total_playtime_minutes || 0,
        stats.first_joined || now_ts,
        now_ts,
        stats.total_sessions || 0,
        stats.player_kills || 0,
        stats.deaths || 0,
        stats.mob_kills || 0,
        stats.damage_dealt || 0,
        stats.damage_taken || 0,
        stats.damage_blocked_by_shield || 0,
        stats.damage_resisted || 0,
        stats.damage_absorbed || 0,
        stats.movement?.distance_walked || 0,
        stats.movement?.distance_sprinted || 0,
        stats.movement?.distance_crouched || 0,
        stats.movement?.distance_flown || 0,
        stats.movement?.distance_climbed || 0,
        stats.movement?.distance_fallen || 0,
        stats.movement?.distance_swam || 0,
        stats.movement?.distance_minecart || 0,
        stats.movement?.distance_boat || 0,
        stats.movement?.distance_pig || 0,
        stats.movement?.distance_horse || 0,
        stats.movement?.distance_elytra || 0,
        stats.movement?.jumps || 0,
        stats.interactions?.times_slept || 0,
        stats.interactions?.barrels_opened || 0,
        stats.interactions?.ender_chests_opened || 0,
        stats.interactions?.items_enchanted || 0,
        stats.interactions?.animals_bred || 0,
        stats.interactions?.fish_caught || 0,
        stats.interactions?.traded_with_villager || 0,
        stats.interactions?.talked_to_villager || 0,
        stats.interactions?.cake_slices_eaten || 0,
        stats.interactions?.bells_rung || 0,
        stats.building?.items_crafted || 0,
        stats.building?.beacons_interacted || 0,
        stats.building?.anvils_used || 0,
        stats.building?.lecterns_interacted || 0,
        stats.building?.grindstones_interacted || 0,
        stats.building?.looms_interacted || 0,
        stats.building?.smithing_tables_interacted || 0,
        stats.building?.stonecutters_interacted || 0,
        stats.misc?.raids_triggered || 0,
        stats.misc?.raids_won || 0,
        stats.misc?.targets_hit || 0,
        stats.misc?.time_since_rest || 0,
        stats.misc?.time_since_death || 0,
        stats.misc?.flower_potted || 0,
        stats.misc?.armor_pieces_cleaned || 0,
        stats.misc?.banners_cleaned || 0,
        stats.current_session?.session_duration_seconds || 0,
        stats.current_session?.login_timestamp || 0,
        JSON.stringify(stats.additional || {}),
        now_ts
      ).run();
    }

    return c.json({ message: 'Stats updated successfully' });
  });

  app.post('/jagsmp/plugin/log-activity', async (c) => {
    const { plugin_secret, minecraft_uuid, activity_type, activity_data } = await c.req.json();
    const db = c.env.DB;

    if (plugin_secret !== c.env.MINECRAFT_PLUGIN_SECRET) {
      return c.json({ error: 'Invalid plugin secret' }, 401);
    }

    if (!minecraft_uuid || !activity_type) {
      return c.json({ error: 'minecraft_uuid and activity_type are required' }, 400);
    }

    const activityId = generateId();
    const now_ts = now();

    await db.prepare(`
      INSERT INTO minecraft_activity_log (id, minecraft_uuid, activity_type, activity_data, occurred_at)
      VALUES (?, ?, ?, ?, ?)
    `).bind(
      activityId,
      minecraft_uuid,
      activity_type,
      JSON.stringify(activity_data || {}),
      now_ts
    ).run();

    return c.json({ message: 'Activity logged successfully' });
  });

  app.post('/jagsmp/plugin/unlock-achievement', async (c) => {
    const { plugin_secret, minecraft_uuid, achievement_key } = await c.req.json();
    const db = c.env.DB;

    if (plugin_secret !== c.env.MINECRAFT_PLUGIN_SECRET) {
      return c.json({ error: 'Invalid plugin secret' }, 401);
    }

    if (!minecraft_uuid || !achievement_key) {
      return c.json({ error: 'minecraft_uuid and achievement_key are required' }, 400);
    }

    const { results: achievements } = await db.prepare(
      'SELECT id, name, points FROM minecraft_achievements WHERE achievement_key = ?'
    ).bind(achievement_key).all();

    if (achievements.length === 0) {
      return c.json({ error: 'Achievement not found' }, 404);
    }

    const achievement = achievements[0];

    const { results: unlocked } = await db.prepare(
      'SELECT id FROM minecraft_player_achievements WHERE minecraft_uuid = ? AND achievement_id = ?'
    ).bind(minecraft_uuid, achievement.id).all();

    if (unlocked.length > 0) {
      return c.json({ message: 'Achievement already unlocked', already_unlocked: true });
    }

    const unlockId = generateId();
    const now_ts = now();

    await db.prepare(`
      INSERT INTO minecraft_player_achievements (id, minecraft_uuid, achievement_id, unlocked_at)
      VALUES (?, ?, ?, ?)
    `).bind(unlockId, minecraft_uuid, achievement.id, now_ts).run();

    const activityId = generateId();
    await db.prepare(`
      INSERT INTO minecraft_activity_log (id, minecraft_uuid, activity_type, activity_data, occurred_at)
      VALUES (?, ?, 'achievement', ?, ?)
    `).bind(
      activityId,
      minecraft_uuid,
      JSON.stringify({ achievement_name: achievement.name, points: achievement.points }),
      now_ts
    ).run();

    return c.json({
      message: 'Achievement unlocked',
      achievement: {
        name: achievement.name,
        points: achievement.points
      }
    });
  });

  app.get('/admin/users', authMiddleware, adminMiddleware, async (c) => {
    const db = c.env.DB;
    const { search, status, role, page = '1', limit = '50' } = c.req.query();

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const offset = (pageNum - 1) * limitNum;

    let whereConditions = [];
    let params = [];

    if (search) {
      whereConditions.push('(username_original LIKE ? OR email LIKE ? OR id = ?)');
      params.push(`%${search}%`, `%${search}%`, search);
    }

    if (status === 'banned') {
      whereConditions.push('is_banned = 1');
    } else if (status === 'locked') {
      whereConditions.push('is_locked = 1');
    } else if (status === 'active') {
      whereConditions.push('is_banned = 0 AND (is_locked = 0 OR is_locked IS NULL)');
    }

    if (role === 'admin') {
      whereConditions.push("role = 'admin'");
    } else if (role === 'user') {
      whereConditions.push("role = 'user'");
    }

    const whereClause = whereConditions.length > 0
      ? 'WHERE ' + whereConditions.join(' AND ')
      : '';

    const countQuery = `SELECT COUNT(*) as count FROM users ${whereClause}`;
    const { results: countResults } = await db.prepare(countQuery).bind(...params).all();
    const total = countResults[0].count;

    const usersQuery = `
      SELECT id, username_original, email, role, is_child, is_banned, ban_reason, banned_at,
             is_locked, lock_reason, locked_at, lock_expires_at, created_at, updated_at
      FROM users
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `;

    const { results: users } = await db.prepare(usersQuery).bind(...params, limitNum, offset).all();

    return c.json({
      users,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        total_pages: Math.ceil(total / limitNum)
      }
    });
  });

  app.get('/admin/users/:userId', authMiddleware, adminMiddleware, async (c) => {
    const userId = c.req.param('userId');
    const db = c.env.DB;

    const { results: users } = await db.prepare(`
      SELECT * FROM users WHERE id = ?
    `).bind(userId).all();

    if (users.length === 0) {
      return c.json({ error: 'User not found' }, 404);
    }

    const user = users[0];

    const { results: modActions } = await db.prepare(`
      SELECT ma.*, u.username_original as moderator_username
      FROM moderation_actions ma
      LEFT JOIN users u ON ma.moderator_id = u.id
      WHERE ma.user_id = ?
      ORDER BY ma.created_at DESC
      LIMIT 20
    `).bind(userId).all();

    const { results: sessionCount } = await db.prepare(`
      SELECT COUNT(*) as count FROM user_sessions
      WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
    `).bind(userId, now()).all();

    const { results: reports } = await db.prepare(`
      SELECT id, report_type, status, priority, created_at
      FROM user_reports
      WHERE reported_user_id = ?
      ORDER BY created_at DESC
      LIMIT 10
    `).bind(userId).all();

    const { results: reportsMade } = await db.prepare(`
      SELECT COUNT(*) as count FROM user_reports WHERE reporter_user_id = ?
    `).bind(userId).all();

    return c.json({
      user,
      moderation_history: modActions,
      active_sessions: sessionCount[0].count,
      reports_against: reports,
      reports_made: reportsMade[0].count
    });
  });

  app.post('/admin/users/:userId/ban', authMiddleware, adminMiddleware, async (c) => {
    const admin = c.get('user');
    const userId = c.req.param('userId');
    const { reason, internal_notes } = await c.req.json();
    const db = c.env.DB;
    const ip = getClientIP(c);

    if (!reason) {
      return c.json({ error: 'Reason is required' }, 400);
    }

    const { results: users } = await db.prepare('SELECT id, is_banned FROM users WHERE id = ?').bind(userId).all();
    if (users.length === 0) {
      return c.json({ error: 'User not found' }, 404);
    }
    if (users[0].is_banned) {
      return c.json({ error: 'User is already banned' }, 400);
    }

    await db.prepare(`
      UPDATE users
      SET is_banned = 1, ban_reason = ?, banned_at = ?, banned_by = ?
      WHERE id = ?
    `).bind(reason, now(), admin.user_id, userId).run();

    const actionId = generateId();
    await db.prepare(`
      INSERT INTO moderation_actions (id, user_id, moderator_id, action_type, reason, internal_notes, created_at)
      VALUES (?, ?, ?, 'ban', ?, ?, ?)
    `).bind(actionId, userId, admin.user_id, reason, internal_notes || null, now()).run();

    await db.prepare(`
      UPDATE user_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL
    `).bind(now(), userId).run();

    await db.prepare(`
      INSERT INTO admin_logs (id, admin_id, action, target_id, target_type, details, ip_address, created_at)
      VALUES (?, ?, 'ban_user', ?, 'user', ?, ?, ?)
    `).bind(generateId(), admin.user_id, userId, JSON.stringify({ reason, internal_notes }), ip, now()).run();

    await db.prepare(`
      INSERT INTO daily_stats (date, accounts_banned, updated_at)
      VALUES (date('now'), 1, ?)
      ON CONFLICT(date) DO UPDATE SET accounts_banned = accounts_banned + 1, updated_at = excluded.updated_at
    `).bind(now()).run();

    return c.json({ message: 'User banned successfully', action_id: actionId });
  });

  app.post('/admin/users/:userId/unban', authMiddleware, adminMiddleware, async (c) => {
    const admin = c.get('user');
    const userId = c.req.param('userId');
    const { reason } = await c.req.json();
    const db = c.env.DB;
    const ip = getClientIP(c);

    const { results: users } = await db.prepare('SELECT id, is_banned FROM users WHERE id = ?').bind(userId).all();
    if (users.length === 0) {
      return c.json({ error: 'User not found' }, 404);
    }
    if (!users[0].is_banned) {
      return c.json({ error: 'User is not banned' }, 400);
    }

    await db.prepare(`
      UPDATE users SET is_banned = 0, ban_reason = NULL, banned_at = NULL, banned_by = NULL WHERE id = ?
    `).bind(userId).run();

    const actionId = generateId();
    await db.prepare(`
      INSERT INTO moderation_actions (id, user_id, moderator_id, action_type, reason, created_at)
      VALUES (?, ?, ?, 'unban', ?, ?)
    `).bind(actionId, userId, admin.user_id, reason || 'Unbanned by admin', now()).run();

    await db.prepare(`
      INSERT INTO admin_logs (id, admin_id, action, target_id, target_type, details, ip_address, created_at)
      VALUES (?, ?, 'unban_user', ?, 'user', ?, ?, ?)
    `).bind(generateId(), admin.user_id, userId, JSON.stringify({ reason }), ip, now()).run();

    return c.json({ message: 'User unbanned successfully', action_id: actionId });
  });

  app.post('/admin/users/:userId/lock', authMiddleware, adminMiddleware, async (c) => {
    const admin = c.get('user');
    const userId = c.req.param('userId');
    const { reason, duration, internal_notes } = await c.req.json();
    const db = c.env.DB;
    const ip = getClientIP(c);

    if (!reason) {
      return c.json({ error: 'Reason is required' }, 400);
    }

    const { results: users } = await db.prepare('SELECT id, is_banned, is_locked FROM users WHERE id = ?').bind(userId).all();
    if (users.length === 0) {
      return c.json({ error: 'User not found' }, 404);
    }
    if (users[0].is_banned) {
      return c.json({ error: 'User is banned, cannot lock a banned account' }, 400);
    }
    if (users[0].is_locked) {
      return c.json({ error: 'User is already locked' }, 400);
    }

    const expiresAt = duration ? now() + duration : null;

    await db.prepare(`
      UPDATE users
      SET is_locked = 1, lock_reason = ?, locked_at = ?, locked_by = ?, lock_expires_at = ?
      WHERE id = ?
    `).bind(reason, now(), admin.user_id, expiresAt, userId).run();

    const actionId = generateId();
    await db.prepare(`
      INSERT INTO moderation_actions (id, user_id, moderator_id, action_type, duration, reason, internal_notes, created_at, expires_at)
      VALUES (?, ?, ?, 'lock', ?, ?, ?, ?, ?)
    `).bind(actionId, userId, admin.user_id, duration || null, reason, internal_notes || null, now(), expiresAt).run();

    await db.prepare(`
      UPDATE user_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL
    `).bind(now(), userId).run();

    await db.prepare(`
      INSERT INTO admin_logs (id, admin_id, action, target_id, target_type, details, ip_address, created_at)
      VALUES (?, ?, 'lock_user', ?, 'user', ?, ?, ?)
    `).bind(generateId(), admin.user_id, userId, JSON.stringify({ reason, duration, internal_notes }), ip, now()).run();

    return c.json({ message: 'User locked successfully', action_id: actionId, expires_at: expiresAt });
  });

  app.post('/admin/users/:userId/unlock', authMiddleware, adminMiddleware, async (c) => {
    const admin = c.get('user');
    const userId = c.req.param('userId');
    const { reason } = await c.req.json();
    const db = c.env.DB;
    const ip = getClientIP(c);

    const { results: users } = await db.prepare('SELECT id, is_locked FROM users WHERE id = ?').bind(userId).all();
    if (users.length === 0) {
      return c.json({ error: 'User not found' }, 404);
    }
    if (!users[0].is_locked) {
      return c.json({ error: 'User is not locked' }, 400);
    }

    await db.prepare(`
      UPDATE users SET is_locked = 0, lock_reason = NULL, locked_at = NULL, locked_by = NULL, lock_expires_at = NULL WHERE id = ?
    `).bind(userId).run();

    const actionId = generateId();
    await db.prepare(`
      INSERT INTO moderation_actions (id, user_id, moderator_id, action_type, reason, created_at)
      VALUES (?, ?, ?, 'unlock', ?, ?)
    `).bind(actionId, userId, admin.user_id, reason || 'Unlocked by admin', now()).run();

    await db.prepare(`
      INSERT INTO admin_logs (id, admin_id, action, target_id, target_type, details, ip_address, created_at)
      VALUES (?, ?, 'unlock_user', ?, 'user', ?, ?, ?)
    `).bind(generateId(), admin.user_id, userId, JSON.stringify({ reason }), ip, now()).run();

    return c.json({ message: 'User unlocked successfully', action_id: actionId });
  });

  app.post('/admin/users/:userId/force-reauth', authMiddleware, adminMiddleware, async (c) => {
    const admin = c.get('user');
    const userId = c.req.param('userId');
    const { reason } = await c.req.json();
    const db = c.env.DB;
    const ip = getClientIP(c);

    const { results: users } = await db.prepare('SELECT id FROM users WHERE id = ?').bind(userId).all();
    if (users.length === 0) {
      return c.json({ error: 'User not found' }, 404);
    }

    const result = await db.prepare(`
      UPDATE user_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL
    `).bind(now(), userId).run();

    await db.prepare(`
      INSERT INTO admin_logs (id, admin_id, action, target_id, target_type, details, ip_address, created_at)
      VALUES (?, ?, 'force_reauth', ?, 'user', ?, ?, ?)
    `).bind(generateId(), admin.user_id, userId, JSON.stringify({ reason, sessions_revoked: result.meta?.changes || 0 }), ip, now()).run();

    return c.json({ message: 'User sessions revoked, re-authentication required', sessions_revoked: result.meta?.changes || 0 });
  });


  app.get('/admin/audit-logs', authMiddleware, adminMiddleware, async (c) => {
    const db = c.env.DB;
    const { admin_id, action, target_type, start_date, end_date, page = '1', limit = '50' } = c.req.query();

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const offset = (pageNum - 1) * limitNum;

    let whereConditions = [];
    let params = [];

    if (admin_id) {
      whereConditions.push('al.admin_id = ?');
      params.push(admin_id);
    }

    if (action) {
      whereConditions.push('al.action = ?');
      params.push(action);
    }

    if (target_type) {
      whereConditions.push('al.target_type = ?');
      params.push(target_type);
    }

    if (start_date) {
      whereConditions.push('al.created_at >= ?');
      params.push(Math.floor(new Date(start_date).getTime() / 1000));
    }

    if (end_date) {
      whereConditions.push('al.created_at <= ?');
      params.push(Math.floor(new Date(end_date).getTime() / 1000));
    }

    const whereClause = whereConditions.length > 0
      ? 'WHERE ' + whereConditions.join(' AND ')
      : '';

    const countQuery = `SELECT COUNT(*) as count FROM admin_logs al ${whereClause}`;
    const { results: countResults } = await db.prepare(countQuery).bind(...params).all();
    const total = countResults[0].count;

    const logsQuery = `
      SELECT al.*, u.username_original as admin_username, tu.username_original as target_username
      FROM admin_logs al
      LEFT JOIN users u ON al.admin_id = u.id
      LEFT JOIN users tu ON al.target_id = tu.id AND al.target_type = 'user'
      ${whereClause}
      ORDER BY al.created_at DESC
      LIMIT ? OFFSET ?
    `;

    const { results: logs } = await db.prepare(logsQuery).bind(...params, limitNum, offset).all();

    const logsWithParsedDetails = logs.map(log => ({
      ...log,
      details: log.details ? JSON.parse(log.details) : null
    }));

    return c.json({
      logs: logsWithParsedDetails,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        total_pages: Math.ceil(total / limitNum)
      }
    });
  });

  app.get('/admin/audit-logs/actions', authMiddleware, adminMiddleware, async (c) => {
    const db = c.env.DB;

    const { results } = await db.prepare('SELECT DISTINCT action FROM admin_logs ORDER BY action').all();

    return c.json({ actions: results.map(r => r.action) });
  });

  app.get('/admin/audit-logs/admins', authMiddleware, adminMiddleware, async (c) => {
    const db = c.env.DB;

    const { results } = await db.prepare(`
      SELECT DISTINCT u.id, u.username_original
      FROM admin_logs al
      JOIN users u ON al.admin_id = u.id
      ORDER BY u.username_original
    `).all();

    return c.json({ admins: results });
  });

  app.get('/settings/notifications', authMiddleware, async (c) => {
    const user = c.get('user');
    const db = c.env.DB;

    const { results: userPrefs } = await db.prepare(
      'SELECT notify_ticket_updates FROM user_notification_preferences WHERE user_id = ?'
    ).bind(user.user_id).all();

    const response = {
      notify_ticket_updates: userPrefs[0] ? Boolean(userPrefs[0].notify_ticket_updates) : true,
    };

    if (user.role === 'admin') {
      const { results: adminPrefs } = await db.prepare(
        'SELECT notify_new_tickets FROM admin_notification_preferences WHERE user_id = ?'
      ).bind(user.user_id).all();
      response.notify_new_tickets = adminPrefs[0] ? Boolean(adminPrefs[0].notify_new_tickets) : true;
    }

    return c.json(response);
  });

  app.put('/settings/notifications', authMiddleware, async (c) => {
    const user = c.get('user');
    const db = c.env.DB;
    const body = await c.req.json();
    const timestamp = now();
    const response = {};

    if (typeof body?.notify_ticket_updates === 'boolean') {
      await db.prepare(`
      INSERT INTO user_notification_preferences (user_id, notify_ticket_updates, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET notify_ticket_updates = excluded.notify_ticket_updates, updated_at = excluded.updated_at
    `).bind(user.user_id, body.notify_ticket_updates ? 1 : 0, timestamp).run();
      response.notify_ticket_updates = body.notify_ticket_updates;
    }

    if (user.role === 'admin' && typeof body?.notify_new_tickets === 'boolean') {
      await db.prepare(`
      INSERT INTO admin_notification_preferences (user_id, notify_new_tickets, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET notify_new_tickets = excluded.notify_new_tickets, updated_at = excluded.updated_at
    `).bind(user.user_id, body.notify_new_tickets ? 1 : 0, timestamp).run();
      response.notify_new_tickets = body.notify_new_tickets;
    }

    if (Object.keys(response).length === 0) {
      return c.json({ error: 'No valid fields provided' }, 400);
    }

    return c.json(response);
  });

  app.get('/admin/moderation-history', authMiddleware, adminMiddleware, async (c) => {
    const db = c.env.DB;
    const { user_id, moderator_id, action_type, page = '1', limit = '50' } = c.req.query();

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const offset = (pageNum - 1) * limitNum;

    let whereConditions = [];
    let params = [];

    if (user_id) {
      whereConditions.push('ma.user_id = ?');
      params.push(user_id);
    }

    if (moderator_id) {
      whereConditions.push('ma.moderator_id = ?');
      params.push(moderator_id);
    }

    if (action_type) {
      whereConditions.push('ma.action_type = ?');
      params.push(action_type);
    }

    const whereClause = whereConditions.length > 0
      ? 'WHERE ' + whereConditions.join(' AND ')
      : '';

    const countQuery = `SELECT COUNT(*) as count FROM moderation_actions ma ${whereClause}`;
    const { results: countResults } = await db.prepare(countQuery).bind(...params).all();
    const total = countResults[0].count;

    const actionsQuery = `
      SELECT ma.*,
             u.username_original as target_username,
             m.username_original as moderator_username
      FROM moderation_actions ma
      LEFT JOIN users u ON ma.user_id = u.id
      LEFT JOIN users m ON ma.moderator_id = m.id
      ${whereClause}
      ORDER BY ma.created_at DESC
      LIMIT ? OFFSET ?
    `;

    const { results: actions } = await db.prepare(actionsQuery).bind(...params, limitNum, offset).all();

    return c.json({
      actions,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        total_pages: Math.ceil(total / limitNum)
      }
    });
  });


  // OIDC discovery for clients.
  app.get('/.well-known/openid-configuration', (c) => {
    const issuer = getIssuer(c);

    return c.json({
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      userinfo_endpoint: `${issuer}/oauth/userinfo`,
      revocation_endpoint: `${issuer}/oauth/revoke`,
      introspection_endpoint: `${issuer}/oauth/introspect`,
      jwks_uri: `${issuer}/.well-known/jwks.json`,
      registration_endpoint: `${issuer}/oauth/clients`,
      scopes_supported: CONFIG.OAUTH_PROVIDER.SUPPORTED_SCOPES,
      response_types_supported: CONFIG.OAUTH_PROVIDER.SUPPORTED_RESPONSE_TYPES,
      response_modes_supported: ['query'],
      grant_types_supported: CONFIG.OAUTH_PROVIDER.SUPPORTED_GRANT_TYPES,
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      code_challenge_methods_supported: CONFIG.OAUTH_PROVIDER.SUPPORTED_CODE_CHALLENGE_METHODS,
      claims_supported: ['sub', 'iss', 'aud', 'exp', 'iat', 'auth_time', 'nonce', 'name', 'preferred_username', 'email', 'email_verified', 'updated_at'],
      service_documentation: 'https://quietterminal.co.uk/docs/oauth',
    });
  });

  // JWKS for token verification by third-party clients.
  app.get('/.well-known/jwks.json', async (c) => {
    const publicKeyPem = c.env.OAUTH_PROVIDER_PUBLIC_KEY;

    if (!publicKeyPem) {
      return c.json({ keys: [] });
    }

    try {
      const publicKey = await importPublicKey(publicKeyPem);
      const jwk = await crypto.subtle.exportKey('jwk', publicKey);

      return c.json({
        keys: [{
          kty: jwk.kty,
          use: 'sig',
          alg: 'RS256',
          // Bump this on key rotation to help clients refresh.
          kid: 'qti-auth-1',
          n: jwk.n,
          e: jwk.e,
        }]
      });
    } catch (e) {
      console.error('JWKS error:', e);
      return c.json({ keys: [] });
    }
  });


  app.post('/oauth/clients', authMiddleware, async (c) => {
    const user = c.get('user');
    const db = c.env.DB;

    if (user.is_child) {
      return c.json({ error: 'Child accounts cannot create OAuth applications' }, 403);
    }

    const { name, description, homepage_url, privacy_policy_url, redirect_uris, client_type = 'confidential', allowed_scopes } = await c.req.json();

    if (!name || name.length < 3 || name.length > 100) {
      return c.json({ error: 'Name must be between 3 and 100 characters' }, 400);
    }

    if (!redirect_uris || !Array.isArray(redirect_uris) || redirect_uris.length === 0) {
      return c.json({ error: 'At least one redirect URI is required' }, 400);
    }

    for (const uri of redirect_uris) {
      try {
        const url = new URL(uri);
        if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
          return c.json({ error: `Redirect URI must use HTTPS: ${uri}` }, 400);
        }
      } catch {
        return c.json({ error: `Invalid redirect URI: ${uri}` }, 400);
      }
    }

    if (client_type !== 'confidential' && client_type !== 'public') {
      return c.json({ error: 'Client type must be "confidential" or "public"' }, 400);
    }

    const resolvedScopes = allowed_scopes ?? ['openid', 'profile', 'email'];
    if (!Array.isArray(resolvedScopes) || resolvedScopes.length === 0) {
      return c.json({ error: 'allowed_scopes must be a non-empty array' }, 400);
    }
    const invalidScopes = resolvedScopes.filter(s => !CONFIG.OAUTH_PROVIDER.SUPPORTED_SCOPES.includes(s));
    if (invalidScopes.length > 0) {
      return c.json({ error: `Unsupported scopes: ${invalidScopes.join(', ')}` }, 400);
    }

    const clientId = generateId();
    const clientSecret = generateSecureToken(32);
    const clientSecretHash = await hashToken(clientSecret);
    const currentTime = now();

    await db.prepare(`
      INSERT INTO oauth_clients (id, client_secret_hash, name, description, homepage_url, privacy_policy_url, redirect_uris, allowed_scopes, client_type, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      clientId,
      clientSecretHash,
      name,
      description || null,
      homepage_url || null,
      privacy_policy_url || null,
      JSON.stringify(redirect_uris),
      JSON.stringify(resolvedScopes),
      client_type,
      user.user_id,
      currentTime,
      currentTime
    ).run();

    return c.json({
      client_id: clientId,
      // Only show the raw secret once; store the hash server-side.
      client_secret: clientSecret,
      name,
      redirect_uris,
      client_type,
      is_approved: false,
      message: 'Save your client secret securely - it will not be shown again. Your app can only be used by you until an admin approves it.',
    }, 201);
  });

  app.get('/oauth/clients', authMiddleware, async (c) => {
    const user = c.get('user');
    const db = c.env.DB;

    const { results } = await db.prepare(`
      SELECT id, name, description, homepage_url, logo_url, redirect_uris, client_type, is_active, is_approved, approval_requested, approval_requested_at, created_at, updated_at
      FROM oauth_clients
      WHERE created_by = ?
      ORDER BY created_at DESC
    `).bind(user.user_id).all();

    return c.json({
      clients: results.map(client => ({
        ...client,
        redirect_uris: JSON.parse(client.redirect_uris),
      }))
    });
  });

  app.get('/oauth/clients/:id', authMiddleware, async (c) => {
    const user = c.get('user');
    const db = c.env.DB;
    const clientId = c.req.param('id');

    const { results } = await db.prepare(`
      SELECT id, name, description, homepage_url, privacy_policy_url, logo_url, redirect_uris, allowed_scopes, client_type, is_active, is_approved, approval_requested, approval_requested_at, created_at, updated_at
      FROM oauth_clients
      WHERE id = ? AND created_by = ?
    `).bind(clientId, user.user_id).all();

    if (results.length === 0) {
      return c.json({ error: 'Client not found' }, 404);
    }

    const client = results[0];
    return c.json({
      ...client,
      redirect_uris: JSON.parse(client.redirect_uris),
      allowed_scopes: JSON.parse(client.allowed_scopes),
    });
  });

  app.put('/oauth/clients/:id', authMiddleware, async (c) => {
    const user = c.get('user');
    const db = c.env.DB;
    const clientId = c.req.param('id');

    const { results: existing } = await db.prepare(
      'SELECT id FROM oauth_clients WHERE id = ? AND created_by = ?'
    ).bind(clientId, user.user_id).all();

    if (existing.length === 0) {
      return c.json({ error: 'Client not found' }, 404);
    }

    const { name, description, homepage_url, privacy_policy_url, redirect_uris, allowed_scopes } = await c.req.json();

    const updates = [];
    const params = [];

    if (allowed_scopes !== undefined) {
      if (!Array.isArray(allowed_scopes) || allowed_scopes.length === 0) {
        return c.json({ error: 'allowed_scopes must be a non-empty array' }, 400);
      }
      const invalidScopes = allowed_scopes.filter(s => !CONFIG.OAUTH_PROVIDER.SUPPORTED_SCOPES.includes(s));
      if (invalidScopes.length > 0) {
        return c.json({ error: `Unsupported scopes: ${invalidScopes.join(', ')}` }, 400);
      }
      updates.push('allowed_scopes = ?');
      params.push(JSON.stringify(allowed_scopes));
    }

    if (name !== undefined) {
      if (name.length < 3 || name.length > 100) {
        return c.json({ error: 'Name must be between 3 and 100 characters' }, 400);
      }
      updates.push('name = ?');
      params.push(name);
    }

    if (description !== undefined) {
      updates.push('description = ?');
      params.push(description);
    }

    if (homepage_url !== undefined) {
      updates.push('homepage_url = ?');
      params.push(homepage_url);
    }

    if (privacy_policy_url !== undefined) {
      updates.push('privacy_policy_url = ?');
      params.push(privacy_policy_url);
    }

    if (redirect_uris !== undefined) {
      if (!Array.isArray(redirect_uris) || redirect_uris.length === 0) {
        return c.json({ error: 'At least one redirect URI is required' }, 400);
      }
      for (const uri of redirect_uris) {
        try {
          const url = new URL(uri);
          if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
            return c.json({ error: `Redirect URI must use HTTPS: ${uri}` }, 400);
          }
        } catch {
          return c.json({ error: `Invalid redirect URI: ${uri}` }, 400);
        }
      }
      updates.push('redirect_uris = ?');
      params.push(JSON.stringify(redirect_uris));
    }

    if (updates.length === 0) {
      return c.json({ error: 'No valid fields to update' }, 400);
    }

    updates.push('updated_at = ?');
    params.push(now());
    params.push(clientId);

    await db.prepare(`UPDATE oauth_clients SET ${updates.join(', ')} WHERE id = ?`).bind(...params).run();

    return c.json({ success: true });
  });

  app.delete('/oauth/clients/:id', authMiddleware, async (c) => {
    const user = c.get('user');
    const db = c.env.DB;
    const clientId = c.req.param('id');

    const result = await db.prepare(
      'DELETE FROM oauth_clients WHERE id = ? AND created_by = ?'
    ).bind(clientId, user.user_id).run();

    if (result.meta?.changes === 0) {
      return c.json({ error: 'Client not found' }, 404);
    }

    return c.json({ success: true });
  });

  app.post('/oauth/clients/:id/regenerate-secret', authMiddleware, async (c) => {
    const user = c.get('user');
    const db = c.env.DB;
    const clientId = c.req.param('id');

    const { results: existing } = await db.prepare(
      'SELECT id FROM oauth_clients WHERE id = ? AND created_by = ?'
    ).bind(clientId, user.user_id).all();

    if (existing.length === 0) {
      return c.json({ error: 'Client not found' }, 404);
    }

    const newSecret = generateSecureToken(32);
    const newSecretHash = await hashToken(newSecret);

    await db.prepare(
      'UPDATE oauth_clients SET client_secret_hash = ?, updated_at = ? WHERE id = ?'
    ).bind(newSecretHash, now(), clientId).run();

    await db.prepare('UPDATE oauth_access_tokens SET revoked = 1 WHERE client_id = ?').bind(clientId).run();
    await db.prepare('UPDATE oauth_refresh_tokens SET revoked = 1 WHERE client_id = ?').bind(clientId).run();

    return c.json({
      client_secret: newSecret,
      message: 'Save your new client secret securely - it will not be shown again. All existing tokens have been revoked.',
    });
  });

  app.post('/oauth/clients/:id/request-approval', authMiddleware, async (c) => {
    const user = c.get('user');
    const db = c.env.DB;
    const clientId = c.req.param('id');

    const { results: existing } = await db.prepare(
      'SELECT id, is_approved, approval_requested FROM oauth_clients WHERE id = ? AND created_by = ?'
    ).bind(clientId, user.user_id).all();

    if (existing.length === 0) {
      return c.json({ error: 'Client not found' }, 404);
    }

    const client = existing[0];

    if (client.is_approved) {
      return c.json({ error: 'Client is already approved' }, 400);
    }

    if (client.approval_requested) {
      return c.json({ error: 'Approval has already been requested' }, 400);
    }

    await db.prepare(
      'UPDATE oauth_clients SET approval_requested = 1, approval_requested_at = ?, updated_at = ? WHERE id = ?'
    ).bind(now(), now(), clientId).run();

    return c.json({
      success: true,
      message: 'Approval requested. An admin will review your application.',
    });
  });


  // Authorization endpoint used by third-party apps.
  app.get('/oauth/authorize', authMiddleware, async (c) => {
    const user = c.get('user');
    const db = c.env.DB;

    if (user.is_child) {
      const errorUrl = new URL(c.env.FRONTEND_URL + '/oauth-error');
      errorUrl.searchParams.set('error', 'access_denied');
      errorUrl.searchParams.set('error_description', 'Child accounts cannot authorize third-party applications');
      return c.redirect(errorUrl.toString());
    }

    const {
      client_id,
      redirect_uri,
      response_type,
      scope = 'openid',
      state,
      code_challenge,
      code_challenge_method,
      nonce,
    } = c.req.query();

    if (!client_id) {
      return c.json({ error: 'invalid_request', error_description: 'client_id is required' }, 400);
    }

    if (!redirect_uri) {
      return c.json({ error: 'invalid_request', error_description: 'redirect_uri is required' }, 400);
    }

    if (response_type !== 'code') {
      return c.json({ error: 'unsupported_response_type', error_description: 'Only response_type=code is supported (OAuth 2.1)' }, 400);
    }

    if (!code_challenge) {
      return c.json({ error: 'invalid_request', error_description: 'code_challenge is required (PKCE mandatory in OAuth 2.1)' }, 400);
    }

    if (code_challenge_method !== 'S256') {
      return c.json({ error: 'invalid_request', error_description: 'code_challenge_method must be S256 (plain not allowed in OAuth 2.1)' }, 400);
    }

    const { results: clients } = await db.prepare(`
      SELECT id, name, description, logo_url, redirect_uris, allowed_scopes, is_active, is_approved, created_by
      FROM oauth_clients WHERE id = ?
    `).bind(client_id).all();

    if (clients.length === 0) {
      return c.json({ error: 'invalid_client', error_description: 'Client not found' }, 400);
    }

    const client = clients[0];

    if (!client.is_active) {
      return c.json({ error: 'invalid_client', error_description: 'Client is not active' }, 400);
    }

    if (!client.is_approved && client.created_by !== user.user_id) {
      return c.json({ error: 'invalid_client', error_description: 'Client is not approved for public use' }, 400);
    }

    if (!validateRedirectUri(redirect_uri, client.redirect_uris)) {
      return c.json({ error: 'invalid_request', error_description: 'redirect_uri does not match any registered URIs' }, 400);
    }

    if (!validateScopes(scope, client.allowed_scopes)) {
      const errorUrl = new URL(redirect_uri);
      errorUrl.searchParams.set('error', 'invalid_scope');
      errorUrl.searchParams.set('error_description', 'Requested scope is not allowed for this client');
      if (state) errorUrl.searchParams.set('state', state);
      return c.redirect(errorUrl.toString());
    }

    const scopes = scope.split(' ').filter(s => s);
    if (!scopes.includes('openid')) {
      const errorUrl = new URL(redirect_uri);
      errorUrl.searchParams.set('error', 'invalid_scope');
      errorUrl.searchParams.set('error_description', 'openid scope is required');
      if (state) errorUrl.searchParams.set('state', state);
      return c.redirect(errorUrl.toString());
    }

    const { results: existingConsents } = await db.prepare(`
      SELECT scope FROM oauth_consents WHERE user_id = ? AND client_id = ?
    `).bind(user.user_id, client_id).all();

    const needsConsent = existingConsents.length === 0 ||
      !scopes.every(s => JSON.parse(existingConsents[0].scope).includes(s));

    if (!needsConsent) {
      const code = generateSecureToken(32);
      const codeHash = await hashToken(code);
      const currentTime = now();

      await db.prepare(`
        INSERT INTO oauth_authorization_codes (code_hash, client_id, user_id, redirect_uri, scope, code_challenge, code_challenge_method, nonce, auth_time, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        codeHash,
        client_id,
        user.user_id,
        redirect_uri,
        scope,
        code_challenge,
        code_challenge_method,
        nonce || null,
        currentTime,
        currentTime,
        currentTime + CONFIG.OAUTH_PROVIDER.AUTH_CODE_EXPIRY
      ).run();

      const callbackUrl = new URL(redirect_uri);
      callbackUrl.searchParams.set('code', code);
      if (state) callbackUrl.searchParams.set('state', state);
      return c.redirect(callbackUrl.toString());
    }

    const consentUrl = new URL(c.env.FRONTEND_URL + '/oauth/authorize');
    consentUrl.searchParams.set('client_id', client_id);
    consentUrl.searchParams.set('redirect_uri', redirect_uri);
    consentUrl.searchParams.set('scope', scope);
    consentUrl.searchParams.set('state', state || '');
    consentUrl.searchParams.set('code_challenge', code_challenge);
    consentUrl.searchParams.set('code_challenge_method', code_challenge_method);
    if (nonce) consentUrl.searchParams.set('nonce', nonce);

    return c.redirect(consentUrl.toString());
  });

  app.get('/oauth/authorize/client-info', authMiddleware, async (c) => {
    const db = c.env.DB;
    const { client_id, scope } = c.req.query();

    if (!client_id) {
      return c.json({ error: 'client_id is required' }, 400);
    }

    const { results } = await db.prepare(`
      SELECT id, name, description, logo_url, homepage_url, privacy_policy_url
      FROM oauth_clients WHERE id = ? AND is_active = 1
    `).bind(client_id).all();

    if (results.length === 0) {
      return c.json({ error: 'Client not found' }, 404);
    }

    const client = results[0];
    const scopes = (scope || 'openid').split(' ').filter(s => s);

    const scopeDescriptions = {
      openid: 'Verify your identity',
      profile: 'Access your username and profile information',
      email: 'Access your email address',
      games: 'Access the list of games you own',
      achievements: 'Access your unlocked achievements across all games',
      game_stats: 'Access your in-game stats for each game',
    };

    return c.json({
      client,
      scopes: scopes.map(s => ({ name: s, description: scopeDescriptions[s] || s })),
    });
  });

  app.post('/oauth/authorize', authMiddleware, async (c) => {
    const user = c.get('user');
    const db = c.env.DB;

    if (user.is_child) {
      return c.json({ error: 'access_denied', error_description: 'Child accounts cannot authorize third-party applications' }, 403);
    }

    const {
      client_id,
      redirect_uri,
      scope,
      state,
      code_challenge,
      code_challenge_method,
      nonce,
      // Consent is an explicit allow/deny string from the UI.
      consent,
    } = await c.req.json();

    if (consent !== 'allow') {
      const errorUrl = new URL(redirect_uri);
      errorUrl.searchParams.set('error', 'access_denied');
      errorUrl.searchParams.set('error_description', 'User denied the authorization request');
      if (state) errorUrl.searchParams.set('state', state);
      return c.json({ redirect: errorUrl.toString() });
    }

    const { results: clients } = await db.prepare(`
      SELECT id, redirect_uris, allowed_scopes, is_active, is_approved, created_by
      FROM oauth_clients WHERE id = ?
    `).bind(client_id).all();

    if (clients.length === 0 || !clients[0].is_active) {
      return c.json({ error: 'invalid_client' }, 400);
    }

    const client = clients[0];

    if (!client.is_approved && client.created_by !== user.user_id) {
      return c.json({ error: 'invalid_client', error_description: 'Client is not approved' }, 400);
    }

    if (!validateRedirectUri(redirect_uri, client.redirect_uris)) {
      return c.json({ error: 'invalid_request', error_description: 'Invalid redirect_uri' }, 400);
    }

    if (!validateScopes(scope, client.allowed_scopes)) {
      return c.json({ error: 'invalid_scope' }, 400);
    }

    const consentId = generateId();
    const currentTime = now();
    const scopes = scope.split(' ').filter(s => s);

    await db.prepare(`
      INSERT INTO oauth_consents (id, user_id, client_id, scope, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, client_id) DO UPDATE SET scope = ?, updated_at = ?
    `).bind(
      consentId,
      user.user_id,
      client_id,
      JSON.stringify(scopes),
      currentTime,
      currentTime,
      JSON.stringify(scopes),
      currentTime
    ).run();

    const code = generateSecureToken(32);
    const codeHash = await hashToken(code);

    await db.prepare(`
      INSERT INTO oauth_authorization_codes (code_hash, client_id, user_id, redirect_uri, scope, code_challenge, code_challenge_method, nonce, auth_time, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      codeHash,
      client_id,
      user.user_id,
      redirect_uri,
      scope,
      code_challenge,
      code_challenge_method,
      nonce || null,
      currentTime,
      currentTime,
      currentTime + CONFIG.OAUTH_PROVIDER.AUTH_CODE_EXPIRY
    ).run();

    const callbackUrl = new URL(redirect_uri);
    callbackUrl.searchParams.set('code', code);
    if (state) callbackUrl.searchParams.set('state', state);

    return c.json({ redirect: callbackUrl.toString() });
  });


  // Token exchange and refresh flows.
  app.post('/oauth/token', async (c) => {
    const db = c.env.DB;
    const contentType = c.req.header('content-type') || '';

    let params;
    if (contentType.includes('application/json')) {
      params = await c.req.json();
    } else {
      params = Object.fromEntries(new URLSearchParams(await c.req.text()));
    }

    const { grant_type, code, redirect_uri, client_id, client_secret, code_verifier, refresh_token } = params;

    let authClientId = client_id;
    let authClientSecret = client_secret;

    const authHeader = c.req.header('authorization');
    if (authHeader?.startsWith('Basic ')) {
      const decoded = atob(authHeader.slice(6));
      const [id, secret] = decoded.split(':');
      authClientId = authClientId || decodeURIComponent(id);
      authClientSecret = authClientSecret || decodeURIComponent(secret);
    }

    if (!authClientId) {
      return c.json({ error: 'invalid_client', error_description: 'client_id is required' }, 401);
    }

    const { results: clients } = await db.prepare(`
      SELECT id, client_secret_hash, client_type, is_active
      FROM oauth_clients WHERE id = ?
    `).bind(authClientId).all();

    if (clients.length === 0) {
      return c.json({ error: 'invalid_client' }, 401);
    }

    const client = clients[0];

    if (!client.is_active) {
      return c.json({ error: 'invalid_client', error_description: 'Client is not active' }, 401);
    }

    if (client.client_type === 'confidential') {
      if (!authClientSecret) {
        return c.json({ error: 'invalid_client', error_description: 'Client authentication required' }, 401);
      }
      const secretHash = await hashToken(authClientSecret);
      if (secretHash !== client.client_secret_hash) {
        return c.json({ error: 'invalid_client', error_description: 'Invalid client credentials' }, 401);
      }
    }

    if (grant_type === 'authorization_code') {
      return handleAuthorizationCodeGrant(c, db, client, code, redirect_uri, code_verifier);
    } else if (grant_type === 'refresh_token') {
      return handleRefreshTokenGrant(c, db, client, refresh_token);
    } else {
      return c.json({ error: 'unsupported_grant_type', error_description: 'Only authorization_code and refresh_token grants are supported' }, 400);
    }
  });

  async function handleAuthorizationCodeGrant(c, db, client, code, redirectUri, codeVerifier) {
    if (!code) {
      return c.json({ error: 'invalid_request', error_description: 'code is required' }, 400);
    }

    if (!codeVerifier) {
      return c.json({ error: 'invalid_request', error_description: 'code_verifier is required (PKCE mandatory)' }, 400);
    }

    const codeHash = await hashToken(code);
    const currentTime = now();

    const { results: codes } = await db.prepare(`
      SELECT * FROM oauth_authorization_codes
      WHERE code_hash = ? AND client_id = ? AND used = 0 AND expires_at > ?
    `).bind(codeHash, client.id, currentTime).all();

    if (codes.length === 0) {
      return c.json({ error: 'invalid_grant', error_description: 'Invalid or expired authorization code' }, 400);
    }

    const authCode = codes[0];

    if (redirectUri && redirectUri !== authCode.redirect_uri) {
      return c.json({ error: 'invalid_grant', error_description: 'redirect_uri does not match' }, 400);
    }

    const pkceValid = await verifyPKCE(codeVerifier, authCode.code_challenge);
    if (!pkceValid) {
      return c.json({ error: 'invalid_grant', error_description: 'Invalid code_verifier' }, 400);
    }

    await db.prepare('UPDATE oauth_authorization_codes SET used = 1 WHERE code_hash = ?').bind(codeHash).run();

    const { results: users } = await db.prepare(`
      SELECT id, username_original, email, updated_at, role
      FROM users WHERE id = ?
    `).bind(authCode.user_id).all();

    if (users.length === 0) {
      return c.json({ error: 'invalid_grant', error_description: 'User not found' }, 400);
    }

    const user = users[0];
    const scopes = authCode.scope.split(' ').filter(s => s);

    const accessToken = generateSecureToken(32);
    const refreshToken = generateSecureToken(32);
    const accessTokenHash = await hashToken(accessToken);
    const refreshTokenHash = await hashToken(refreshToken);

    const accessTokenExpiry = currentTime + CONFIG.OAUTH_PROVIDER.ACCESS_TOKEN_EXPIRY;
    const refreshTokenExpiry = currentTime + CONFIG.OAUTH_PROVIDER.REFRESH_TOKEN_EXPIRY;

    await db.prepare(`
      INSERT INTO oauth_access_tokens (token_hash, client_id, user_id, scope, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(accessTokenHash, client.id, user.id, authCode.scope, currentTime, accessTokenExpiry).run();

    await db.prepare(`
      INSERT INTO oauth_refresh_tokens (token_hash, client_id, user_id, scope, access_token_hash, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(refreshTokenHash, client.id, user.id, authCode.scope, accessTokenHash, currentTime, refreshTokenExpiry).run();

    const idTokenPayload = {
      iss: getIssuer(c),
      sub: user.id,
      aud: client.id,
      exp: currentTime + CONFIG.OAUTH_PROVIDER.ID_TOKEN_EXPIRY,
      iat: currentTime,
      auth_time: authCode.auth_time,
    };

    if (authCode.nonce) {
      idTokenPayload.nonce = authCode.nonce;
    }

    idTokenPayload.at_hash = await generateAtHash(accessToken);

    const userClaims = buildUserClaims(user, scopes);
    Object.assign(idTokenPayload, userClaims);

    const privateKey = c.env.OAUTH_PROVIDER_PRIVATE_KEY;
    if (!privateKey) {
      return c.json({ error: 'server_error', error_description: 'Server signing key not configured' }, 500);
    }

    const idToken = await signJwtRS256(idTokenPayload, privateKey);

    return c.json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: CONFIG.OAUTH_PROVIDER.ACCESS_TOKEN_EXPIRY,
      refresh_token: refreshToken,
      id_token: idToken,
      scope: authCode.scope,
    });
  }

  async function handleRefreshTokenGrant(c, db, client, refreshToken) {
    if (!refreshToken) {
      return c.json({ error: 'invalid_request', error_description: 'refresh_token is required' }, 400);
    }

    const tokenHash = await hashToken(refreshToken);
    const currentTime = now();

    const { results: tokens } = await db.prepare(`
      SELECT * FROM oauth_refresh_tokens
      WHERE token_hash = ? AND client_id = ? AND revoked = 0 AND expires_at > ?
    `).bind(tokenHash, client.id, currentTime).all();

    if (tokens.length === 0) {
      return c.json({ error: 'invalid_grant', error_description: 'Invalid or expired refresh token' }, 400);
    }

    const oldRefreshToken = tokens[0];

    const { results: users } = await db.prepare(`
      SELECT id, username_original, email, updated_at, is_banned
      FROM users WHERE id = ?
    `).bind(oldRefreshToken.user_id).all();

    if (users.length === 0 || users[0].is_banned) {
      return c.json({ error: 'invalid_grant', error_description: 'User not found or banned' }, 400);
    }

    const user = users[0];

    await db.prepare('UPDATE oauth_refresh_tokens SET revoked = 1 WHERE token_hash = ?').bind(tokenHash).run();
    if (oldRefreshToken.access_token_hash) {
      await db.prepare('UPDATE oauth_access_tokens SET revoked = 1 WHERE token_hash = ?').bind(oldRefreshToken.access_token_hash).run();
    }

    const newAccessToken = generateSecureToken(32);
    const newRefreshToken = generateSecureToken(32);
    const newAccessTokenHash = await hashToken(newAccessToken);
    const newRefreshTokenHash = await hashToken(newRefreshToken);

    const accessTokenExpiry = currentTime + CONFIG.OAUTH_PROVIDER.ACCESS_TOKEN_EXPIRY;
    const refreshTokenExpiry = currentTime + CONFIG.OAUTH_PROVIDER.REFRESH_TOKEN_EXPIRY;

    await db.prepare(`
      INSERT INTO oauth_access_tokens (token_hash, client_id, user_id, scope, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(newAccessTokenHash, client.id, user.id, oldRefreshToken.scope, currentTime, accessTokenExpiry).run();

    await db.prepare(`
      INSERT INTO oauth_refresh_tokens (token_hash, client_id, user_id, scope, access_token_hash, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(newRefreshTokenHash, client.id, user.id, oldRefreshToken.scope, newAccessTokenHash, currentTime, refreshTokenExpiry).run();

    return c.json({
      access_token: newAccessToken,
      token_type: 'Bearer',
      expires_in: CONFIG.OAUTH_PROVIDER.ACCESS_TOKEN_EXPIRY,
      refresh_token: newRefreshToken,
      scope: oldRefreshToken.scope,
    });
  }


  app.get('/oauth/userinfo', async (c) => {
    const db = c.env.DB;

    const authHeader = c.req.header('authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({ error: 'invalid_token', error_description: 'Bearer token required' }, 401);
    }

    const accessToken = authHeader.slice(7);
    const tokenHash = await hashToken(accessToken);
    const currentTime = now();

    const { results: tokens } = await db.prepare(`
      SELECT user_id, scope FROM oauth_access_tokens
      WHERE token_hash = ? AND revoked = 0 AND expires_at > ?
    `).bind(tokenHash, currentTime).all();

    if (tokens.length === 0) {
      return c.json({ error: 'invalid_token', error_description: 'Invalid or expired access token' }, 401);
    }

    const token = tokens[0];

    const { results: users } = await db.prepare(`
      SELECT id, username_original, email, updated_at, role
      FROM users WHERE id = ?
    `).bind(token.user_id).all();

    if (users.length === 0) {
      return c.json({ error: 'invalid_token', error_description: 'User not found' }, 401);
    }

    const user = users[0];
    const scopes = token.scope.split(' ').filter(s => s);

    const response = buildUserClaims(user, scopes);

    if (scopes.includes('games')) {
      const { results: ownedGames } = await db.prepare(`
      SELECT g.id, g.name, g.slug, g.description, g.icon_url, go.granted_at
      FROM games_owned go
      JOIN games g ON g.id = go.game_id
      WHERE go.user_id = ? AND g.is_active = 1 AND g.admin_only = 0
      ORDER BY go.granted_at ASC
    `).bind(token.user_id).all();
      response.games = ownedGames;
    }

    if (scopes.includes('game_stats')) {
      const { results: gameStats } = await db.prepare(`
      SELECT g.id AS game_id, g.name AS game_name, g.slug AS game_slug,
             ugs.stats_data, ugs.last_played
      FROM user_game_stats ugs
      JOIN games g ON g.id = ugs.game_id
      WHERE ugs.user_id = ? AND g.is_active = 1 AND g.admin_only = 0
      ORDER BY ugs.last_played DESC
    `).bind(token.user_id).all();
      response.game_stats = gameStats.map(r => ({
        ...r,
        stats_data: r.stats_data ? JSON.parse(r.stats_data) : {},
      }));
    }

    if (scopes.includes('achievements')) {
      const { results: achievements } = await db.prepare(`
      SELECT ga.id, ga.name, ga.description, ga.icon_url, ga.points,
             g.id AS game_id, g.name AS game_name, g.slug AS game_slug,
             ua.unlocked_at
      FROM user_achievements ua
      JOIN game_achievements ga ON ga.id = ua.achievement_id
      JOIN games g ON g.id = ga.game_id
      WHERE ua.user_id = ? AND g.is_active = 1 AND g.admin_only = 0
      ORDER BY ua.unlocked_at ASC
    `).bind(token.user_id).all();
      response.achievements = achievements;
    }

    return c.json(response);
  });

  app.post('/oauth/userinfo', async (c) => {
    return app.fetch(new Request(c.req.url, { method: 'GET', headers: c.req.raw.headers }), c.env, c.executionCtx);
  });


  app.post('/oauth/revoke', async (c) => {
    const db = c.env.DB;
    const contentType = c.req.header('content-type') || '';

    let params;
    if (contentType.includes('application/json')) {
      params = await c.req.json();
    } else {
      params = Object.fromEntries(new URLSearchParams(await c.req.text()));
    }

    const { token, token_type_hint, client_id, client_secret } = params;

    if (!token) {
      return c.json({ error: 'invalid_request', error_description: 'token is required' }, 400);
    }

    let authClientId = client_id;
    let authClientSecret = client_secret;

    const authHeader = c.req.header('authorization');
    if (authHeader?.startsWith('Basic ')) {
      const decoded = atob(authHeader.slice(6));
      const [id, secret] = decoded.split(':');
      authClientId = authClientId || decodeURIComponent(id);
      authClientSecret = authClientSecret || decodeURIComponent(secret);
    }

    if (authClientId) {
      const { results: clients } = await db.prepare(`
        SELECT id, client_secret_hash, client_type FROM oauth_clients WHERE id = ?
      `).bind(authClientId).all();

      if (clients.length > 0 && clients[0].client_type === 'confidential') {
        const secretHash = await hashToken(authClientSecret || '');
        if (secretHash !== clients[0].client_secret_hash) {
          return c.json({ error: 'invalid_client' }, 401);
        }
      }
    }

    const tokenHash = await hashToken(token);

    if (token_type_hint !== 'refresh_token') {
      await db.prepare('UPDATE oauth_access_tokens SET revoked = 1 WHERE token_hash = ?').bind(tokenHash).run();
    }

    if (token_type_hint !== 'access_token') {
      await db.prepare('UPDATE oauth_refresh_tokens SET revoked = 1 WHERE token_hash = ?').bind(tokenHash).run();
    }

    return c.json({});
  });

  app.post('/oauth/introspect', async (c) => {
    const db = c.env.DB;
    const contentType = c.req.header('content-type') || '';

    let params;
    if (contentType.includes('application/json')) {
      params = await c.req.json();
    } else {
      params = Object.fromEntries(new URLSearchParams(await c.req.text()));
    }

    const { token, token_type_hint, client_id, client_secret } = params;

    if (!token) {
      return c.json({ error: 'invalid_request', error_description: 'token is required' }, 400);
    }

    let authClientId = client_id;
    let authClientSecret = client_secret;

    const authHeader = c.req.header('authorization');
    if (authHeader?.startsWith('Basic ')) {
      const decoded = atob(authHeader.slice(6));
      const [id, secret] = decoded.split(':');
      authClientId = authClientId || decodeURIComponent(id);
      authClientSecret = authClientSecret || decodeURIComponent(secret);
    }

    if (!authClientId) {
      return c.json({ error: 'invalid_client', error_description: 'Client authentication required' }, 401);
    }

    const { results: clients } = await db.prepare(`
      SELECT id, client_secret_hash, client_type FROM oauth_clients WHERE id = ?
    `).bind(authClientId).all();

    if (clients.length === 0) {
      return c.json({ error: 'invalid_client' }, 401);
    }

    if (clients[0].client_type === 'confidential') {
      const secretHash = await hashToken(authClientSecret || '');
      if (secretHash !== clients[0].client_secret_hash) {
        return c.json({ error: 'invalid_client' }, 401);
      }
    }

    const tokenHash = await hashToken(token);
    const currentTime = now();

    if (token_type_hint !== 'refresh_token') {
      const { results: accessTokens } = await db.prepare(`
        SELECT at.*, u.username_original, u.email
        FROM oauth_access_tokens at
        JOIN users u ON at.user_id = u.id
        WHERE at.token_hash = ?
      `).bind(tokenHash).all();

      if (accessTokens.length > 0) {
        const t = accessTokens[0];
        const active = t.revoked === 0 && t.expires_at > currentTime;

        return c.json({
          active,
          scope: t.scope,
          client_id: t.client_id,
          username: t.username_original,
          token_type: 'Bearer',
          exp: t.expires_at,
          iat: t.created_at,
          sub: t.user_id,
          aud: t.client_id,
          iss: getIssuer(c),
        });
      }
    }

    if (token_type_hint !== 'access_token') {
      const { results: refreshTokens } = await db.prepare(`
        SELECT rt.*, u.username_original
        FROM oauth_refresh_tokens rt
        JOIN users u ON rt.user_id = u.id
        WHERE rt.token_hash = ?
      `).bind(tokenHash).all();

      if (refreshTokens.length > 0) {
        const t = refreshTokens[0];
        const active = t.revoked === 0 && t.expires_at > currentTime;

        return c.json({
          active,
          scope: t.scope,
          client_id: t.client_id,
          username: t.username_original,
          token_type: 'refresh_token',
          exp: t.expires_at,
          iat: t.created_at,
          sub: t.user_id,
        });
      }
    }

    return c.json({ active: false });
  });


  app.get('/oauth/authorized-apps', authMiddleware, async (c) => {
    const user = c.get('user');
    const db = c.env.DB;

    const { results } = await db.prepare(`
      SELECT oc.id, oc.client_id, oc.scope, oc.created_at, oc.updated_at,
             c.name, c.description, c.logo_url, c.homepage_url
      FROM oauth_consents oc
      JOIN oauth_clients c ON oc.client_id = c.id
      WHERE oc.user_id = ?
      ORDER BY oc.updated_at DESC
    `).bind(user.user_id).all();

    return c.json({
      apps: results.map(app => ({
        ...app,
        scope: JSON.parse(app.scope),
      }))
    });
  });

  app.delete('/oauth/authorized-apps/:client_id', authMiddleware, async (c) => {
    const user = c.get('user');
    const db = c.env.DB;
    const clientId = c.req.param('client_id');

    await db.prepare('DELETE FROM oauth_consents WHERE user_id = ? AND client_id = ?')
      .bind(user.user_id, clientId).run();

    await db.prepare('UPDATE oauth_access_tokens SET revoked = 1 WHERE user_id = ? AND client_id = ?')
      .bind(user.user_id, clientId).run();
    await db.prepare('UPDATE oauth_refresh_tokens SET revoked = 1 WHERE user_id = ? AND client_id = ?')
      .bind(user.user_id, clientId).run();

    return c.json({ success: true });
  });


  app.get('/admin/oauth/clients', authMiddleware, adminMiddleware, async (c) => {
    const db = c.env.DB;
    const { is_approved, page = '1', limit = '50' } = c.req.query();

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const offset = (pageNum - 1) * limitNum;

    let whereClause = '';
    const params = [];

    if (is_approved !== undefined) {
      whereClause = 'WHERE is_approved = ?';
      params.push(is_approved === 'true' ? 1 : 0);
    }

    const { results: countResults } = await db.prepare(
      `SELECT COUNT(*) as count FROM oauth_clients ${whereClause}`
    ).bind(...params).all();
    const total = countResults[0].count;

    const { results } = await db.prepare(`
      SELECT oc.*, u.username_original as created_by_username
      FROM oauth_clients oc
      JOIN users u ON oc.created_by = u.id
      ${whereClause}
      ORDER BY oc.created_at DESC
      LIMIT ? OFFSET ?
    `).bind(...params, limitNum, offset).all();

    return c.json({
      clients: results.map(client => ({
        ...client,
        redirect_uris: JSON.parse(client.redirect_uris),
        allowed_scopes: JSON.parse(client.allowed_scopes),
      })),
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        total_pages: Math.ceil(total / limitNum),
      }
    });
  });

  app.post('/admin/oauth/clients/:id/approve', authMiddleware, adminMiddleware, async (c) => {
    const db = c.env.DB;
    const clientId = c.req.param('id');
    const admin = c.get('user');

    const result = await db.prepare(
      'UPDATE oauth_clients SET is_approved = 1, approval_requested = 0, updated_at = ? WHERE id = ?'
    ).bind(now(), clientId).run();

    if (result.meta?.changes === 0) {
      return c.json({ error: 'Client not found' }, 404);
    }

    await db.prepare(`
      INSERT INTO admin_logs (id, admin_id, action, target_id, target_type, details, ip_address, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      generateId(),
      admin.user_id,
      'oauth_client_approved',
      clientId,
      'oauth_client',
      JSON.stringify({ action: 'approved' }),
      getClientIP(c),
      now()
    ).run();

    return c.json({ success: true });
  });

  app.post('/admin/oauth/clients/:id/revoke', authMiddleware, adminMiddleware, async (c) => {
    const db = c.env.DB;
    const clientId = c.req.param('id');
    const admin = c.get('user');

    const result = await db.prepare(
      'UPDATE oauth_clients SET is_approved = 0, updated_at = ? WHERE id = ?'
    ).bind(now(), clientId).run();

    if (result.meta?.changes === 0) {
      return c.json({ error: 'Client not found' }, 404);
    }

    await db.prepare(`
      INSERT INTO admin_logs (id, admin_id, action, target_id, target_type, details, ip_address, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      generateId(),
      admin.user_id,
      'oauth_client_revoked',
      clientId,
      'oauth_client',
      JSON.stringify({ action: 'revoked' }),
      getClientIP(c),
      now()
    ).run();

    return c.json({ success: true });
  });


  // Issue a signed JWT lease for a game the authenticated user owns.
  app.post('/game/lease', authMiddleware, async (c) => {
    const db = c.env.DB;
    const user = c.get('user');
    const { game_slug } = await c.req.json();

    if (!game_slug) {
      return c.json({ error: 'game_slug is required' }, 400);
    }

    const row = await db.prepare(`
    SELECT g.id, g.slug FROM games_owned go
    JOIN games g ON g.id = go.game_id
    WHERE go.user_id = ? AND g.slug = ? AND g.is_active = 1
  `).bind(user.user_id, game_slug).first();

    if (!row) {
      return c.json({ error: 'You do not own this game' }, 403);
    }

    const privateKey = c.env.OAUTH_PROVIDER_PRIVATE_KEY;
    if (!privateKey) {
      return c.json({ error: 'Lease signing is not configured' }, 500);
    }

    const issuedAt = now();
    const expiresAt = issuedAt + CONFIG.GAME_LEASE_DURATION;

    const lease = await signJwtRS256({
      type: 'game_lease',
      sub: user.user_id,
      product_id: row.id,
      product_slug: row.slug,
      iss: getIssuer(c),
      iat: issuedAt,
      exp: expiresAt,
    }, privateKey);

    const leaseId = generateId();
    await db.prepare(`
    INSERT INTO game_leases (id, user_id, game_id, issued_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).bind(leaseId, user.user_id, row.id, issuedAt, expiresAt).run();

    return c.json({ lease, expires_at: expiresAt });
  });

  // Verify a game lease JWT (no auth required — called by game servers).
  app.post('/game/lease/verify', async (c) => {
    const { lease } = await c.req.json();

    if (!lease) {
      return c.json({ valid: false, reason: 'lease is required' }, 400);
    }

    const publicKey = c.env.OAUTH_PROVIDER_PUBLIC_KEY;
    if (!publicKey) {
      return c.json({ valid: false, reason: 'Verification not configured' }, 500);
    }

    try {
      const parts = lease.split('.');
      if (parts.length !== 3) {
        return c.json({ valid: false, reason: 'malformed' });
      }

      const headerPayload = `${parts[0]}.${parts[1]}`;
      const signature = base64UrlDecode(parts[2]);
      const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1])));

      if (payload.type !== 'game_lease') {
        return c.json({ valid: false, reason: 'not_a_lease' });
      }

      if (payload.exp && payload.exp < now()) {
        return c.json({ valid: false, reason: 'expired' });
      }

      const key = await importPublicKey(publicKey);
      const encoder = new TextEncoder();
      const valid = await crypto.subtle.verify(
        'RSASSA-PKCS1-v1_5',
        key,
        signature,
        encoder.encode(headerPayload)
      );

      if (!valid) {
        return c.json({ valid: false, reason: 'invalid_signature' });
      }

      const db = c.env.DB;
      const revoked = await db.prepare(`
      SELECT id FROM game_leases
      WHERE user_id = ? AND game_id = ? AND revoked_at IS NOT NULL
        AND issued_at = ? AND expires_at = ?
    `).bind(payload.sub, payload.product_id, payload.iat, payload.exp).first();

      if (revoked) {
        return c.json({ valid: false, reason: 'revoked' });
      }

      return c.json({
        valid: true,
        user_id: payload.sub,
        product_id: payload.product_id,
        product_slug: payload.product_slug,
        expires_at: payload.exp,
      });
    } catch (e) {
      console.error('Lease verification failed:', e);
      return c.json({ valid: false, reason: 'verification_error' });
    }
  });

  // Admin: revoke all active leases for a user/game combination.
  app.post('/admin/game/lease/revoke', authMiddleware, adminMiddleware, async (c) => {
    const db = c.env.DB;
    const { user_id, game_slug } = await c.req.json();

    if (!user_id || !game_slug) {
      return c.json({ error: 'user_id and game_slug are required' }, 400);
    }

    const game = await db.prepare('SELECT id FROM games WHERE slug = ?').bind(game_slug).first();
    if (!game) {
      return c.json({ error: 'Game not found' }, 404);
    }

    const result = await db.prepare(`
    UPDATE game_leases SET revoked_at = ?
    WHERE user_id = ? AND game_id = ? AND revoked_at IS NULL AND expires_at > ?
  `).bind(now(), user_id, game.id, now()).run();

    return c.json({ message: 'Leases revoked', count: result.meta.changes });
  });


  // TODO: Replace ALLOWED_APP_IDS (remove 480 test entry) and set STEAM_API_KEY secret once you have real credentials
  const ALLOWED_APP_IDS = [480, 123456];

  app.post('/steam/verify', async (c) => {
    const { ticket, appId } = await c.req.json();

    if (!ticket || appId === undefined) {
      return c.json({ valid: false }, 400);
    }

    if (!ALLOWED_APP_IDS.includes(appId)) {
      return c.json({ valid: false }, 400);
    }

    // TODO: Replace test key 64DABCC7574DBDFD0693E2A5DD451CC5 with real STEAM_API_KEY secret
    const STEAM_API_KEY = c.env.STEAM_API_KEY || '64DABCC7574DBDFD0693E2A5DD451CC5';

    const params = new URLSearchParams({
      key: STEAM_API_KEY,
      appid: String(appId),
      ticket,
      identity: 'qti-auth-server',
    });
    const valveUrl = `https://partner.steam-api.com/ISteamUserAuth/AuthenticateUserTicket/v1/?${params}`;

    let data;
    try {
      const valveResp = await fetch(valveUrl);
      data = await valveResp.json();
    } catch (err) {
      console.error('[steam/verify] Valve fetch failed:', err?.message ?? err);
      return c.json({ valid: false }, 502);
    }

    const result = data?.response?.params;

    if (!result || result.result !== 'OK') {
      return c.json({ valid: false }, 401);
    }

    return c.json({ valid: true, admin: false });
  });


  app.get('/health', (c) => {
    return c.json({ status: 'ok', timestamp: now() });
  });

}
