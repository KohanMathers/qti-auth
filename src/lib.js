import { sign } from 'hono/jwt';

import { CONFIG } from './config.js';

export async function checkRateLimit(db, key, limit, windowSeconds) {
  const now_ts = now();
  const windowStart = now_ts - windowSeconds;

  // Cleanup before counting to keep hot paths light.
  await db.prepare(
    'DELETE FROM mail_rate_limits WHERE key = ? AND timestamp < ?'
  ).bind(key, windowStart).run();

  const { results } = await db.prepare(
    'SELECT COUNT(*) as count FROM mail_rate_limits WHERE key = ? AND timestamp >= ?'
  ).bind(key, windowStart).all();

  if (results[0].count >= limit) {
    return { allowed: false, remaining: 0 };
  }

  await db.prepare(
    'INSERT INTO mail_rate_limits (key, timestamp) VALUES (?, ?)'
  ).bind(key, now_ts).run();

  return {
    allowed: true,
    remaining: limit - results[0].count - 1,
  };
}

export function getClientIP(c) {
  return c.req.header('cf-connecting-ip') ||
    c.req.header('x-real-ip') ||
    c.req.header('x-forwarded-for')?.split(',')[0] ||
    'unknown';
}

export function generateId() {
  return crypto.randomUUID();
}

export function now() {
  return Math.floor(Date.now() / 1000);
}

export function normalizeEmail(email) {
  if (!email) return null;

  email = email.toLowerCase().trim();

  // Gmail ignores dots and everything after "+" in the local part.
  if (email.endsWith('@gmail.com')) {
    const [local] = email.split('@');
    const cleaned = local.replace(/\./g, '').split('+')[0];
    return `${cleaned}@gmail.com`;
  }

  const [local, domain] = email.split('@');
  return `${local.split('+')[0]}@${domain}`;
}

export function normalizeUsername(username) {
  return username.toLowerCase();
}

export function slugify(value) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function calculateAge(dateOfBirth) {
  const dob = new Date(dateOfBirth);
  const today = new Date();
  let age = today.getFullYear() - dob.getFullYear();
  const monthDiff = today.getMonth() - dob.getMonth();

  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dob.getDate())) {
    age--;
  }

  return age;
}

export function isValidDateOfBirth(dob) {
  const date = new Date(dob);
  if (isNaN(date.getTime())) return false;

  const today = new Date();
  const minDate = new Date(1900, 0, 1);

  return date >= minDate && date <= today;
}

export async function hashToken(token) {
  const encoder = new TextEncoder();
  const data = encoder.encode(token);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export function base64UrlEncode(data) {
  const base64 = btoa(String.fromCharCode(...new Uint8Array(data)));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

export function base64UrlEncodeString(str) {
  const encoder = new TextEncoder();
  return base64UrlEncode(encoder.encode(str));
}

export function base64UrlDecode(str) {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padding = '='.repeat((4 - base64.length % 4) % 4);
  const decoded = atob(base64 + padding);
  return new Uint8Array([...decoded].map(c => c.charCodeAt(0)));
}

export async function importPrivateKey(pemKey) {
  const pemContents = pemKey
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s/g, '');
  // PEM uses standard base64; convert to base64url for our decoder.
  const binaryKey = base64UrlDecode(pemContents.replace(/\+/g, '-').replace(/\//g, '_'));

  return await crypto.subtle.importKey(
    'pkcs8',
    binaryKey,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

export async function importPublicKey(pemKey) {
  const pemContents = pemKey
    .replace(/-----BEGIN PUBLIC KEY-----/, '')
    .replace(/-----END PUBLIC KEY-----/, '')
    .replace(/\s/g, '');
  // PEM uses standard base64; convert to base64url for our decoder.
  const binaryKey = base64UrlDecode(pemContents.replace(/\+/g, '-').replace(/\//g, '_'));

  return await crypto.subtle.importKey(
    'spki',
    binaryKey,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    true,
    ['verify']
  );
}

export async function signJwtRS256(payload, privateKeyPem) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const headerB64 = base64UrlEncodeString(JSON.stringify(header));
  const payloadB64 = base64UrlEncodeString(JSON.stringify(payload));
  const message = `${headerB64}.${payloadB64}`;

  const privateKey = await importPrivateKey(privateKeyPem);
  const encoder = new TextEncoder();
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    privateKey,
    encoder.encode(message)
  );

  return `${message}.${base64UrlEncode(signature)}`;
}

export async function generateAtHash(accessToken) {
  const encoder = new TextEncoder();
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(accessToken));
  const halfHash = new Uint8Array(hash).slice(0, 16);
  return base64UrlEncode(halfHash);
}

export async function verifyPKCE(codeVerifier, codeChallenge) {
  const encoder = new TextEncoder();
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(codeVerifier));
  const computedChallenge = base64UrlEncode(hash);
  return computedChallenge === codeChallenge;
}

export function generateSecureToken(length = 32) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export function getIssuer(c) {
  return c.env.API_URL || 'https://auth.quietterminal.co.uk';
}

export function buildUserClaims(user, scopes) {
  const claims = {};

  if (scopes.includes('openid')) {
    claims.sub = user.id;
  }

  if (scopes.includes('profile')) {
    claims.name = user.username_original;
    claims.preferred_username = user.username_original;
    claims.updated_at = user.updated_at;
  }

  if (scopes.includes('email')) {
    claims.email = user.email;
    claims.email_verified = true;
  }

  return claims;
}

export function validateRedirectUri(redirectUri, registeredUris) {
  try {
    const uris = JSON.parse(registeredUris);
    return uris.includes(redirectUri);
  } catch {
    return false;
  }
}

export function validateScopes(requestedScopes, allowedScopes) {
  try {
    const allowed = JSON.parse(allowedScopes);
    const requested = requestedScopes.split(' ').filter(s => s);
    return requested.every(scope => allowed.includes(scope));
  } catch {
    return false;
  }
}

export function getIPSubnet(ip) {
  if (!ip || ip === 'unknown') return 'unknown';

  const parts = ip.split('.');
  if (parts.length === 4) {
    return parts.slice(0, 3).join('.');
  }

  if (ip.toLowerCase().startsWith('::ffff:')) {
    const ipv4Part = ip.substring(7);
    const ipv4Parts = ipv4Part.split('.');
    if (ipv4Parts.length === 4) {
      return ipv4Parts.slice(0, 3).join('.');
    }
  }

  let expanded = ip;
  if (ip.includes('::')) {
    const [left, right] = ip.split('::');
    const leftParts = left ? left.split(':') : [];
    const rightParts = right ? right.split(':') : [];
    const missing = 8 - leftParts.length - rightParts.length;
    const middle = Array(missing).fill('0000');
    expanded = [...leftParts, ...middle, ...rightParts].join(':');
  }

  const groups = expanded.split(':');
  if (groups.length >= 3) {
    return groups.slice(0, 3).map(g => g.padStart(4, '0')).join(':');
  }

  return ip;
}

export function collectFingerprint(c) {
  const fingerprint = {
    ip: getClientIP(c),
    ipSubnet: getIPSubnet(getClientIP(c)),
    ipCountry: c.req.header('cf-ipcountry') || null,
    userAgent: c.req.header('user-agent') || null,
    tlsFingerprint: c.req.header('cf-ja3') || c.req.header('cf-ja4') || null,
    language: c.req.header('accept-language') || null,
    timezone: c.req.header('x-client-timezone') || null,
    screenResolution: c.req.header('x-client-screen') || null,
    browserFingerprint: c.req.header('x-browser-fingerprint') || null,
  };
  return fingerprint;
}

export function detectDeviceType(userAgent) {
  if (!userAgent) return 'unknown';
  const ua = userAgent.toLowerCase();
  if (ua.includes('mobile') || ua.includes('android') || ua.includes('iphone')) {
    return 'mobile';
  }
  if (ua.includes('tablet') || ua.includes('ipad')) {
    return 'tablet';
  }
  return 'desktop';
}

export function validateSessionFingerprint(session, currentFingerprint) {
  const matchDetails = {
    ipMatch: false,
    ipSubnetMatch: false,
    userAgentMatch: false,
    browserFingerprintMatch: false,
    tlsFingerprintMatch: false,
    timezoneMatch: false,
    screenMatch: false,
    countryMatch: false,
  };

  matchDetails.ipMatch = session.ip_address === currentFingerprint.ip;

  matchDetails.ipSubnetMatch = session.ip_subnet === currentFingerprint.ipSubnet;

  if (session.user_agent && currentFingerprint.userAgent) {
    matchDetails.userAgentMatch = session.user_agent === currentFingerprint.userAgent;
  }

  if (session.browser_fingerprint && currentFingerprint.browserFingerprint) {
    matchDetails.browserFingerprintMatch = session.browser_fingerprint === currentFingerprint.browserFingerprint;
  }

  if (session.tls_fingerprint && currentFingerprint.tlsFingerprint) {
    matchDetails.tlsFingerprintMatch = session.tls_fingerprint === currentFingerprint.tlsFingerprint;
  }

  if (session.timezone && currentFingerprint.timezone) {
    matchDetails.timezoneMatch = session.timezone === currentFingerprint.timezone;
  }

  if (session.screen_resolution && currentFingerprint.screenResolution) {
    matchDetails.screenMatch = session.screen_resolution === currentFingerprint.screenResolution;
  }

  if (session.ip_country && currentFingerprint.ipCountry) {
    matchDetails.countryMatch = session.ip_country === currentFingerprint.ipCountry;
  }


  if (matchDetails.ipMatch) {
    return {
      valid: true,
      trustLevel: 'full',
      reason: 'ip_match',
      matchDetails,
    };
  }

  // Country mismatch is a hard stop even if other signals look good.
  if (session.ip_country && currentFingerprint.ipCountry &&
    session.ip_country !== currentFingerprint.ipCountry) {
    return {
      valid: false,
      trustLevel: 'suspicious',
      reason: 'country_mismatch',
      matchDetails,
    };
  }

  if (matchDetails.ipSubnetMatch) {
    const fingerprintMatches = [
      matchDetails.userAgentMatch,
      matchDetails.browserFingerprintMatch,
      matchDetails.tlsFingerprintMatch,
      matchDetails.timezoneMatch,
      matchDetails.screenMatch,
    ].filter(Boolean).length;

    if (fingerprintMatches >= 2) {
      return {
        valid: true,
        trustLevel: 'partial',
        reason: 'subnet_with_fingerprints',
        matchDetails,
      };
    }
  }

  const totalMatches = [
    matchDetails.userAgentMatch,
    matchDetails.browserFingerprintMatch,
    matchDetails.tlsFingerprintMatch,
    matchDetails.timezoneMatch,
    matchDetails.screenMatch,
  ].filter(Boolean).length;

  if (totalMatches >= 3) {
    return {
      valid: true,
      trustLevel: 'partial',
      reason: 'fingerprints_only',
      matchDetails,
    };
  }

  const clientFingerprintMissing = !currentFingerprint.timezone &&
    !currentFingerprint.screenResolution &&
    !currentFingerprint.browserFingerprint;
  // If the frontend doesn't send fingerprint headers yet, keep UX alive.
  if (matchDetails.userAgentMatch && clientFingerprintMissing) {
    return {
      valid: true,
      trustLevel: 'partial',
      reason: 'user_agent_only_no_client_fingerprint',
      matchDetails,
    };
  }

  return {
    valid: false,
    trustLevel: 'blocked',
    reason: 'no_match',
    matchDetails,
  };
}

export async function logSecurityEvent(db, eventType, sessionId, userId, ip, country, details) {
  try {
    if (userId) {
      const hourAgo = now() - 3600;
      const { results } = await db.prepare(
        'SELECT COUNT(*) as count FROM session_security_events WHERE user_id = ? AND created_at > ?'
      ).bind(userId, hourAgo).all();

      if (results[0].count >= CONFIG.SECURITY_EVENT_RATE_LIMIT) {
        console.warn(`Security event rate limit exceeded for user ${userId}`);
        return;
      }
    }

    await db.prepare(`
      INSERT INTO session_security_events (id, session_id, user_id, event_type, ip_address, ip_country, details, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(generateId(), sessionId, userId, eventType, ip, country, JSON.stringify(details), now()).run();
  } catch (e) {
    console.error('Failed to log security event:', e);
  }
}

export async function sendSecurityAlert(c, user, eventType, details) {
  if (!c.env.EMAIL_SERVICE_API_KEY || !user.email) return;

  const db = c.env.DB;

  try {
    const rateCheck = await checkRateLimit(
      db,
      `security_alert:${user.email}`,
      CONFIG.SECURITY_ALERT_RATE_LIMIT,
      3600
    );

    if (!rateCheck.allowed) {
      console.warn(`Security alert rate limit exceeded for ${user.email}`);
      return;
    }
  } catch (e) {
    console.error('Failed to check security alert rate limit:', e);
  }

  try {
    await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'api-key': c.env.EMAIL_SERVICE_API_KEY,
      },
      body: JSON.stringify({
        sender: { name: 'QTI Security', email: 'security@account.quietterminal.co.uk' },
        to: [{ email: user.email }],
        subject: 'Security Alert: Suspicious login attempt on your QTI account',
        htmlContent: `
          <!DOCTYPE html>
          <html>
          <head><meta charset="utf-8"></head>
          <body style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
            <h1 style="color: #dc2626;">⚠️ Security Alert</h1>
            <p>We detected a suspicious login attempt on your QTI account.</p>
            <div style="background: #fef2f2; border: 1px solid #fecaca; padding: 16px; border-radius: 8px; margin: 20px 0;">
              <p><strong>Event:</strong> ${eventType}</p>
              <p><strong>IP Address:</strong> ${details.ip || 'Unknown'}</p>
              <p><strong>Location:</strong> ${details.country || 'Unknown'}</p>
              <p><strong>Time:</strong> ${new Date().toISOString()}</p>
            </div>
            <p><strong>If this was you:</strong> You may need to sign in again.</p>
            <p><strong>If this wasn't you:</strong> Your session has been blocked. Consider reviewing your account security.</p>
            <p style="color: #6b7280; font-size: 12px; margin-top: 40px;">
              &copy; ${new Date().getFullYear()} Quiet Terminal Interactive
            </p>
          </body>
          </html>
        `,
      }),
    });
  } catch (e) {
    console.error('Failed to send security alert:', e);
  }
}

export async function checkProfanity(text, db) {
  const lowerText = text.toLowerCase();

  const { results } = await db.prepare(
    'SELECT word FROM banned_words WHERE case_sensitive = 0'
  ).all();

  for (const row of results) {
    if (lowerText.includes(row.word.toLowerCase())) {
      return { isProfane: true, word: row.word };
    }
  }

  return { isProfane: false };
}

export function validateUsername(username) {
  const errors = [];

  if (username.length < CONFIG.USERNAME_MIN_LENGTH) {
    errors.push(`Username must be at least ${CONFIG.USERNAME_MIN_LENGTH} characters`);
  }

  if (username.length > CONFIG.USERNAME_MAX_LENGTH) {
    errors.push(`Username must be no more than ${CONFIG.USERNAME_MAX_LENGTH} characters`);
  }

  if (!/^[A-Za-z0-9_]+$/.test(username)) {
    errors.push('Username can only contain letters, numbers, and underscores');
  }

  if (username.toUpperCase().startsWith(CONFIG.ADMIN_PREFIX)) {
    errors.push('This prefix is reserved');
  }

  return errors;
}

export async function createSession(user) {
  const payload = {
    user_id: user.id,
    username: user.username_original,
    role: user.role,
    is_child: Boolean(user.is_child),
    iat: now(),
    exp: now() + CONFIG.SESSION_DURATION,
  };

  return await sign(payload, CONFIG.JWT_SECRET);
}

export async function createSecureSession(c, user, authMethod) {
  const db = c.env.DB;
  const fingerprint = collectFingerprint(c);

  const token = await createSession(user);
  const tokenHash = await hashToken(token);

  const sessionId = generateId();
  const userAgentHash = fingerprint.userAgent
    ? await hashToken(fingerprint.userAgent)
    : null;

  try {
    const { results: existingSessions } = await db.prepare(`
      SELECT id FROM user_sessions
      WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
      ORDER BY created_at ASC
    `).bind(user.id, now()).all();

    if (existingSessions.length >= CONFIG.MAX_SESSIONS_PER_USER) {
      const sessionsToRevoke = existingSessions.slice(0, existingSessions.length - CONFIG.MAX_SESSIONS_PER_USER + 1);
      // Sorry, oldest sessions: the cap is real, the cap is enforced.
      for (const oldSession of sessionsToRevoke) {
        await db.prepare(
          'UPDATE user_sessions SET revoked_at = ?, flag_reason = ? WHERE id = ?'
        ).bind(now(), 'session_limit_exceeded', oldSession.id).run();
      }
    }

    await db.prepare(`
      INSERT INTO user_sessions (
        id, user_id, token_hash,
        ip_address, ip_subnet, ip_country,
        user_agent, user_agent_hash, browser_fingerprint, tls_fingerprint,
        timezone, screen_resolution, language,
        auth_method, device_type, trust_level,
        created_at, last_active_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      sessionId,
      user.id,
      tokenHash,
      fingerprint.ip,
      fingerprint.ipSubnet,
      fingerprint.ipCountry,
      fingerprint.userAgent,
      userAgentHash,
      fingerprint.browserFingerprint,
      fingerprint.tlsFingerprint,
      fingerprint.timezone,
      fingerprint.screenResolution,
      fingerprint.language,
      authMethod,
      detectDeviceType(fingerprint.userAgent),
      'full',
      now(),
      now(),
      now() + CONFIG.SESSION_DURATION
    ).run();

    await logSecurityEvent(db, 'new_session', sessionId, user.id, fingerprint.ip, fingerprint.ipCountry, {
      authMethod,
      userAgent: fingerprint.userAgent,
      deviceType: detectDeviceType(fingerprint.userAgent),
    });
  } catch (e) {
    console.error('Failed to create session record:', e);
  }

  return { token, sessionId };
}

export function generateLinkCode() {
  // Avoid ambiguous glyphs in human-typed codes.
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}
