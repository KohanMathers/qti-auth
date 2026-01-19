// QTI Auth Worker - UK OSA Compliant
// Cloudflare Workers + D1

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { jwt, sign, verify } from 'hono/jwt';

const app = new Hono();

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  JWT_SECRET: 'REPLACE_WITH_STRONG_SECRET_IN_PRODUCTION', // Use wrangler secrets
  SESSION_DURATION: 7 * 24 * 60 * 60, // 7 days in seconds
  EMAIL_TOKEN_EXPIRY: 15 * 60, // 15 minutes
  USERNAME_MIN_LENGTH: 8,
  USERNAME_MAX_LENGTH: 18,
  MAX_ACCOUNTS_PER_EMAIL: 2,
  USERNAME_CHANGE_COOLDOWN: 30 * 24 * 60 * 60, // 30 days
  MAX_USERNAME_CHANGES_PER_YEAR: 3,
  ADMIN_PREFIX: 'QTI_',

  // UK OSA - Report SLA
  REPORT_REVIEW_SLA: 24 * 60 * 60, // 24 hours
};

// Report types aligned with UK OSA priority offences
const REPORT_TYPES = {
  ILLEGAL_CONTENT: 'illegal_content',
  HARMFUL_TO_CHILD: 'harmful_to_child',
  HARASSMENT: 'harassment',
  HATE_SPEECH: 'hate_speech',
  THREATS: 'threats',
  SELF_HARM: 'self_harm',
  FRAUD: 'fraud',
  SPAM: 'spam',
  OTHER: 'other',
};

const REPORT_SUBTYPES = {
  // Illegal content
  CSAM: 'csam',
  TERRORISM: 'terrorism',
  EXTREME_VIOLENCE: 'extreme_violence',

  // Harassment & threats
  STALKING: 'stalking',
  THREATENING_COMMS: 'threatening_communications',
  INCITING_VIOLENCE: 'inciting_violence',

  // Hate speech
  RACIAL_HATRED: 'racial_hatred',
  RELIGIOUS_HATRED: 'religious_hatred',
  HOMOPHOBIC_HATRED: 'homophobic_hatred',

  // Self-harm
  SUICIDE_PROMOTION: 'suicide_promotion',
  SELF_HARM_PROMOTION: 'self_harm_promotion',
  EATING_DISORDER: 'eating_disorder',

  // Child safety
  GROOMING: 'grooming',
  INAPPROPRIATE_CONTACT: 'inappropriate_contact',
  CHILD_ENDANGERMENT: 'child_endangerment',
};

const RATE_LIMITS = {
  EMAIL_REQUESTS_PER_HOUR: 3,        // Max email requests per email per hour
  EMAIL_REQUESTS_PER_IP_HOUR: 10,    // Max email requests per IP per hour
  EMAIL_REQUESTS_PER_IP_DAY: 20,     // Max email requests per IP per day
  GLOBAL_REQUESTS_PER_MINUTE: 100,   // Global limit to prevent DoS
};

// ============================================================================
// UTILITIES
// ============================================================================

async function checkRateLimit(db, key, limit, windowSeconds) {
  const now_ts = now();
  const windowStart = now_ts - windowSeconds;

  // Clean up old entries
  await db.prepare(
    'DELETE FROM mail_rate_limits WHERE key = ? AND timestamp < ?'
  ).bind(key, windowStart).run();

  // Count recent requests
  const { results } = await db.prepare(
    'SELECT COUNT(*) as count FROM mail_rate_limits WHERE key = ? AND timestamp >= ?'
  ).bind(key, windowStart).all();

  if (results[0].count >= limit) {
    return { allowed: false, remaining: 0 };
  }

  // Record this request
  await db.prepare(
    'INSERT INTO mail_rate_limits (key, timestamp) VALUES (?, ?)'
  ).bind(key, now_ts).run();

  return {
    allowed: true,
    remaining: limit - results[0].count - 1
  };
}

function getClientIP(c) {
  // Try various headers for the real IP
  return c.req.header('cf-connecting-ip') ||
    c.req.header('x-real-ip') ||
    c.req.header('x-forwarded-for')?.split(',')[0] ||
    'unknown';
}

function generateId() {
  return crypto.randomUUID();
}

function now() {
  return Math.floor(Date.now() / 1000);
}

function normalizeEmail(email) {
  if (!email) return null;

  email = email.toLowerCase().trim();

  // Handle Gmail dots and plus addressing
  if (email.endsWith('@gmail.com')) {
    const [local] = email.split('@');
    const cleaned = local.replace(/\./g, '').split('+')[0];
    return `${cleaned}@gmail.com`;
  }

  // Generic plus addressing
  const [local, domain] = email.split('@');
  return `${local.split('+')[0]}@${domain}`;
}

function normalizeUsername(username) {
  return username.toLowerCase();
}

function calculateAge(dateOfBirth) {
  const dob = new Date(dateOfBirth);
  const today = new Date();
  let age = today.getFullYear() - dob.getFullYear();
  const monthDiff = today.getMonth() - dob.getMonth();

  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dob.getDate())) {
    age--;
  }

  return age;
}

function isValidDateOfBirth(dob) {
  const date = new Date(dob);
  if (isNaN(date.getTime())) return false;

  const today = new Date();
  const minDate = new Date(1900, 0, 1);

  return date >= minDate && date <= today;
}

async function hashToken(token) {
  const encoder = new TextEncoder();
  const data = encoder.encode(token);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// ============================================================================
// SESSION SECURITY - FINGERPRINTING & VALIDATION
// ============================================================================

// Extract /24 subnet from IP address (e.g., "192.168.1.100" -> "192.168.1")
function getIPSubnet(ip) {
  if (!ip || ip === 'unknown') return 'unknown';
  // Handle IPv4
  const parts = ip.split('.');
  if (parts.length === 4) {
    return parts.slice(0, 3).join('.');
  }
  // Handle IPv6 - use first 48 bits (3 groups)
  const ipv6Parts = ip.split(':');
  if (ipv6Parts.length >= 3) {
    return ipv6Parts.slice(0, 3).join(':');
  }
  return ip;
}

// Collect all available fingerprint data from request
function collectFingerprint(c) {
  const fingerprint = {
    ip: getClientIP(c),
    ipSubnet: getIPSubnet(getClientIP(c)),
    ipCountry: c.req.header('cf-ipcountry') || null, // Cloudflare provides this
    userAgent: c.req.header('user-agent') || null,
    tlsFingerprint: c.req.header('cf-ja3') || c.req.header('cf-ja4') || null, // Cloudflare JA3/JA4
    language: c.req.header('accept-language') || null,
    // These come from client-side fingerprinting (passed in request body/headers)
    timezone: c.req.header('x-client-timezone') || null,
    screenResolution: c.req.header('x-client-screen') || null,
    browserFingerprint: c.req.header('x-browser-fingerprint') || null,
  };
  return fingerprint;
}

// Parse fingerprint data from JSON body (for login requests)
function parseClientFingerprint(body) {
  return {
    timezone: body?.fingerprint?.timezone || null,
    screenResolution: body?.fingerprint?.screen || null,
    browserFingerprint: body?.fingerprint?.hash || null,
  };
}

// Detect device type from User-Agent
function detectDeviceType(userAgent) {
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

// Validate session against current request fingerprint
// Returns: { valid: boolean, trustLevel: string, reason: string, matchDetails: object }
function validateSessionFingerprint(session, currentFingerprint) {
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

  // Check IP (strict match)
  matchDetails.ipMatch = session.ip_address === currentFingerprint.ip;

  // Check IP subnet (/24 - loose match)
  matchDetails.ipSubnetMatch = session.ip_subnet === currentFingerprint.ipSubnet;

  // Check User-Agent
  if (session.user_agent && currentFingerprint.userAgent) {
    matchDetails.userAgentMatch = session.user_agent === currentFingerprint.userAgent;
  }

  // Check browser fingerprint (canvas, WebGL, fonts hash)
  if (session.browser_fingerprint && currentFingerprint.browserFingerprint) {
    matchDetails.browserFingerprintMatch = session.browser_fingerprint === currentFingerprint.browserFingerprint;
  }

  // Check TLS fingerprint (JA3/JA4)
  if (session.tls_fingerprint && currentFingerprint.tlsFingerprint) {
    matchDetails.tlsFingerprintMatch = session.tls_fingerprint === currentFingerprint.tlsFingerprint;
  }

  // Check timezone
  if (session.timezone && currentFingerprint.timezone) {
    matchDetails.timezoneMatch = session.timezone === currentFingerprint.timezone;
  }

  // Check screen resolution
  if (session.screen_resolution && currentFingerprint.screenResolution) {
    matchDetails.screenMatch = session.screen_resolution === currentFingerprint.screenResolution;
  }

  // Check country
  if (session.ip_country && currentFingerprint.ipCountry) {
    matchDetails.countryMatch = session.ip_country === currentFingerprint.ipCountry;
  }

  // === VALIDATION LOGIC ===

  // PERFECT MATCH: IP matches exactly
  if (matchDetails.ipMatch) {
    return {
      valid: true,
      trustLevel: 'full',
      reason: 'ip_match',
      matchDetails,
    };
  }

  // SUSPICIOUS: Different country entirely
  if (session.ip_country && currentFingerprint.ipCountry &&
      session.ip_country !== currentFingerprint.ipCountry) {
    return {
      valid: false,
      trustLevel: 'suspicious',
      reason: 'country_mismatch',
      matchDetails,
    };
  }

  // LOOSE MATCH: Same /24 subnet + 2 or more fingerprint matches
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

  // NO MATCH: Different IP, insufficient fingerprint matches
  const totalMatches = [
    matchDetails.userAgentMatch,
    matchDetails.browserFingerprintMatch,
    matchDetails.tlsFingerprintMatch,
    matchDetails.timezoneMatch,
    matchDetails.screenMatch,
  ].filter(Boolean).length;

  // If we have 3+ fingerprint matches even without IP, allow but flag
  if (totalMatches >= 3) {
    return {
      valid: true,
      trustLevel: 'partial',
      reason: 'fingerprints_only',
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

// Log security event
async function logSecurityEvent(db, eventType, sessionId, userId, ip, country, details) {
  try {
    await db.prepare(`
      INSERT INTO session_security_events (id, session_id, user_id, event_type, ip_address, ip_country, details, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(generateId(), sessionId, userId, eventType, ip, country, JSON.stringify(details), now()).run();
  } catch (e) {
    console.error('Failed to log security event:', e);
  }
}

// Send security alert email (for suspicious activity)
async function sendSecurityAlert(c, user, eventType, details) {
  if (!c.env.EMAIL_SERVICE_API_KEY || !user.email) return;

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

async function checkProfanity(text, db) {
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

function validateUsername(username) {
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

async function createSession(user) {
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

// Create session with fingerprint tracking (enhanced security)
async function createSecureSession(c, user, authMethod) {
  const db = c.env.DB;
  const fingerprint = collectFingerprint(c);

  // Create JWT token
  const token = await createSession(user);
  const tokenHash = await hashToken(token);

  // Create session record
  const sessionId = generateId();
  const userAgentHash = fingerprint.userAgent ? await hashToken(fingerprint.userAgent) : null;

  try {
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

    // Log new session event
    await logSecurityEvent(db, 'new_session', sessionId, user.id, fingerprint.ip, fingerprint.ipCountry, {
      authMethod,
      userAgent: fingerprint.userAgent,
      deviceType: detectDeviceType(fingerprint.userAgent),
    });
  } catch (e) {
    console.error('Failed to create session record:', e);
    // Continue even if session tracking fails - token is still valid
  }

  return { token, sessionId };
}

// ============================================================================
// MIDDLEWARE
// ============================================================================

app.use('/*', cors());

// Auth middleware with session fingerprint validation
const authMiddleware = async (c, next) => {
  try {
    // Accept token from Authorization header or cookie named `qti_token`
    let token = c.req.header('Authorization')?.replace('Bearer ', '');
    if (!token) {
      const cookieHeader = c.req.header('cookie') || '';
      const match = cookieHeader.match(/(?:^|; )qti_token=([^;]+)/);
      if (match) token = match[1];
    }
    if (!token) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const payload = await verify(token, CONFIG.JWT_SECRET);
    const db = c.env.DB;

    // Look up session by token hash
    const tokenHash = await hashToken(token);
    const { results: sessions } = await db.prepare(
      'SELECT * FROM user_sessions WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?'
    ).bind(tokenHash, now()).all();

    // If no session found, this is a legacy token or session was revoked
    if (sessions.length === 0) {
      // For backwards compatibility during migration, allow tokens without session records
      // but flag them for re-auth on next opportunity
      c.set('user', payload);
      c.set('session_trust', 'legacy');
      await next();
      return;
    }

    const session = sessions[0];
    const currentFingerprint = collectFingerprint(c);

    // Validate fingerprint
    const validation = validateSessionFingerprint(session, currentFingerprint);

    if (!validation.valid) {
      // Get user info for alert
      const { results: users } = await db.prepare(
        'SELECT email FROM users WHERE id = ?'
      ).bind(payload.user_id).all();
      const user = users[0] || {};

      if (validation.trustLevel === 'suspicious') {
        // Different country - send email alert and block
        await logSecurityEvent(db, 'country_change', session.id, payload.user_id,
          currentFingerprint.ip, currentFingerprint.ipCountry, {
            originalCountry: session.ip_country,
            newCountry: currentFingerprint.ipCountry,
            validation: validation.matchDetails,
          });

        // Send security alert email
        await sendSecurityAlert(c, user, 'Suspicious login from different country', {
          ip: currentFingerprint.ip,
          country: currentFingerprint.ipCountry,
          originalCountry: session.ip_country,
        });

        // Revoke the session
        await db.prepare(
          'UPDATE user_sessions SET revoked_at = ?, trust_level = ?, flag_reason = ? WHERE id = ?'
        ).bind(now(), 'blocked', 'country_mismatch', session.id).run();

        return c.json({
          error: 'Session blocked due to suspicious activity',
          code: 'SESSION_BLOCKED_COUNTRY',
          requires_reauth: true,
        }, 401);
      }

      // No match at all - force re-auth
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

    // Valid session - update last_active_at
    await db.prepare(
      'UPDATE user_sessions SET last_active_at = ? WHERE id = ?'
    ).bind(now(), session.id).run();

    // If partial match, flag the session but allow
    if (validation.trustLevel === 'partial') {
      if (session.trust_level !== 'partial') {
        await db.prepare(
          'UPDATE user_sessions SET trust_level = ?, flagged_at = ?, flag_reason = ? WHERE id = ?'
        ).bind('partial', now(), validation.reason, session.id).run();

        await logSecurityEvent(db, 'ip_change', session.id, payload.user_id,
          currentFingerprint.ip, currentFingerprint.ipCountry, {
            originalIP: session.ip_address,
            newIP: currentFingerprint.ip,
            validation: validation.matchDetails,
          });
      }
    }

    c.set('user', payload);
    c.set('session', session);
    c.set('session_trust', validation.trustLevel);
    await next();
  } catch (err) {
    return c.json({ error: 'Invalid token' }, 401);
  }
};

// Admin middleware
const adminMiddleware = async (c, next) => {
  const user = c.get('user');
  if (user.role !== 'admin') {
    return c.json({ error: 'Forbidden' }, 403);
  }
  await next();
};

// ============================================================================
// OAUTH ROUTES
// ============================================================================

app.post('/auth/oauth/start', async (c) => {
  const { provider } = await c.req.json();
  const db = c.env.DB;

  // Build provider-specific OAuth authorization URL using configured client IDs
  const state = generateId();
  const redirectUri = (c.env.OAUTH_REDIRECT_URI || 'https://auth.quietterminal.co.uk/auth/oauth/callback').trim();

  // Persist state -> provider mapping for callback lookup (short-lived)
  try {
    await db.prepare(`
      INSERT INTO oauth_states (state, provider, created_at)
      VALUES (?, ?, ?)
    `).bind(state, provider, now()).run();
  } catch (e) {
    // If table doesn't exist or insert fails, log and continue; callback will fall back to provider param if present
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

  // Note: we're not persisting `state` in D1/KV here; for production you should store it and validate on callback.
  return c.json({ redirect_url: url, state });
});

// Support direct GET navigation from the frontend (so window.location.href to this path doesn't 404)
app.get('/auth/oauth/start', async (c) => {
  const { provider } = c.req.query();

  // If someone navigates directly, build the same full URL as the POST handler
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

app.get('/auth/oauth/callback', async (c) => {
  const { code, state } = c.req.query();
  let provider = c.req.query().provider;
  const db = c.env.DB;

  if (!code) return c.json({ error: 'Missing code' }, 400);

  let oauthUser = { provider, id: null, email: null, birthdate: null };

  // If provider was not provided in the callback (some redirects don't include it),
  // attempt to look it up from the persisted state mapping.
  if (!provider && state) {
    try {
      const { results: stateRows } = await db.prepare(
        'SELECT provider FROM oauth_states WHERE state = ?'
      ).bind(state).all();

      if (stateRows.length > 0) {
        oauthUser.provider = stateRows[0].provider;
        // Optionally delete the row to avoid reuse
        await db.prepare('DELETE FROM oauth_states WHERE state = ?').bind(state).run();
      } else {
        return c.json({ error: 'Unknown OAuth state; provider not found' }, 400);
      }
    } catch (e) {
      console.error('Failed to lookup oauth state:', e);
      return c.json({ error: 'Failed to validate oauth state' }, 500);
    }
  }

  // Ensure the local `provider` variable reflects any provider found via state lookup
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
      // Google doesn't normally return birthdate in standard scopes
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
        // Redact sensitive token before returning to client for debugging
        const safeToken = Object.assign({}, tokenJson);
        if (safeToken && safeToken.access_token) safeToken.access_token = '<redacted>';
        return c.json({ error: 'Failed to fetch GitHub user', details: text, token: safeToken }, 500);
      }

      const userInfo = await userRes.json();
      oauthUser.id = String(userInfo.id);
      // Try to get email; may be null on /user
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

  // Check if user exists
  const { results } = await db.prepare(
    'SELECT * FROM users WHERE oauth_provider = ? AND oauth_id = ?'
  ).bind(provider, oauthUser.id).all();

  let user = results[0];

  if (user) {
    // Existing user - update last login
    await db.prepare(
      'UPDATE users SET updated_at = ? WHERE id = ?'
    ).bind(now(), user.id).run();
  } else {
    // New user - need age verification
    if (!oauthUser.birthdate) {
      // Persist temporary OAuth data so frontend can collect DOB and finish registration
      const tempToken = generateId();
      try {
        await db.prepare(`
          INSERT INTO oauth_temp (id, provider, oauth_id, email, created_at)
          VALUES (?, ?, ?, ?, ?)
        `).bind(tempToken, oauthUser.provider, oauthUser.id, oauthUser.email, now()).run();
      } catch (e) {
        console.error('Failed to persist oauth_temp:', e);
        // Fallback to returning JSON token but note that age flow may fail
      }

      // If request expects HTML (browser), redirect to frontend age verification page
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

    // Check account limit before creating new user
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

    // Create new user
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

  // Check if username claimed
  if (!user.username_original) {
    // Create a secure session so browser can be authenticated while choosing a username
    const { token: sessionToken } = await createSecureSession(c, user, `oauth_${provider}`);
    try {
      const domain = c.env.COOKIE_DOMAIN || '.quietterminal.co.uk';
      const cookie = `qti_token=${sessionToken}; Path=/; Domain=${domain}; HttpOnly; Secure; SameSite=Lax; Max-Age=${CONFIG.SESSION_DURATION}`;
      c.header('Set-Cookie', cookie);
    } catch (e) {
      console.error('Failed to set cookie on OAuth callback (needs_username):', e);
    }

    const accept = c.req.header('accept') || '';
    const frontendUrl = c.env.FRONTEND_URL || 'https://account.quietterminal.co.uk';

    if (accept.includes('text/html')) {
      // Redirect browser to claim username page and include token so frontend can store it
      return c.redirect(`${frontendUrl}/claim-username?token=${sessionToken}`);
    }

    return c.json({
      needs_username: true,
      token: sessionToken,
      user: { id: user.id, email: user.email },
    });
  }

  const { token } = await createSecureSession(c, user, `oauth_${provider}`);
  // Set session cookie
  try {
    const domain = c.env.COOKIE_DOMAIN || '.quietterminal.co.uk';
    const cookie = `qti_token=${token}; Path=/; Domain=${domain}; HttpOnly; Secure; SameSite=Lax; Max-Age=${CONFIG.SESSION_DURATION}`;
    c.header('Set-Cookie', cookie);
  } catch (e) {
    console.error('Failed to set cookie on OAuth callback:', e);
  }

  const accept = c.req.header('accept') || '';
  const frontendUrl = c.env.FRONTEND_URL || 'https://account.quietterminal.co.uk';
  if (accept.includes('text/html')) {
    // Redirect to verify page with JWT token (same as magic link flow)
    return c.redirect(`${frontendUrl}/verify?token=${token}`);
  }

  return c.json({ token, user });
});

// ============================================================================
// EMAIL AUTH ROUTES
// ============================================================================

app.post('/auth/email/start', async (c) => {
  const { email, date_of_birth } = await c.req.json();
  const db = c.env.DB;
  const clientIP = getClientIP(c);

  if (!email) {
    return c.json({ error: 'Email required' }, 400);
  }

  const emailNorm = normalizeEmail(email);

  // Check if a user already exists for this email (non-OAuth)
  const { results: existingUsers } = await db.prepare(
    'SELECT * FROM users WHERE email_normalized = ? AND oauth_provider IS NULL'
  ).bind(emailNorm).all();

  const userExists = existingUsers.length > 0;

  // If this is a new email (no user exists), require date_of_birth for age verification
  if (!userExists && !date_of_birth) {
    return c.json({ error: 'Date of birth required for new accounts' }, 400);
  }

  // Validate DOB only if it's provided. New accounts already require DOB above.
  if (date_of_birth && !isValidDateOfBirth(date_of_birth)) {
    return c.json({ error: 'Invalid date of birth' }, 400);
  }

  // Rate limit #1: Per email address (3 per hour)
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

  // Rate limit #2: Per IP per hour (10 per hour)
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

  // Rate limit #3: Per IP per day (20 per day)
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

  // Check account limit ONLY for new accounts (when user doesn't exist)
  if (!userExists) {
    const { results: existingCount } = await db.prepare(
      'SELECT COUNT(*) as count FROM users WHERE email_normalized = ?'
    ).bind(emailNorm).all();

    if (existingCount[0].count >= CONFIG.MAX_ACCOUNTS_PER_EMAIL) {
      return c.json({ error: 'This email already has the maximum number of accounts' }, 400);
    }
  }

  // Generate magic link token
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
    // store provided DOB if present; if user exists, we can store their DOB
    userExists ? (existingUsers[0].date_of_birth || date_of_birth) : date_of_birth,
    now() + CONFIG.EMAIL_TOKEN_EXPIRY,
    now()
  ).run();

  // Send email with token
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

// Add global rate limiting middleware for all routes
app.use('/*', async (c, next) => {
  const db = c.env.DB;
  const clientIP = getClientIP(c);

  // Global rate limit: 100 requests per minute per IP
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

  // Mark token as used
  await db.prepare(
    'UPDATE email_tokens SET used = 1 WHERE id = ?'
  ).bind(tokenData.id).run();

  // Check if user exists with this email
  const { results: users } = await db.prepare(
    'SELECT * FROM users WHERE email_normalized = ? AND oauth_provider IS NULL'
  ).bind(tokenData.email_normalized).all();

  let user;

  if (users.length > 0) {
    user = users[0];
  } else {
    // Create new user
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

  // Check if username claimed
  if (!user.username_original) {
    // Create a secure session token so the user can continue to claim a username
    const { token: sessionToken } = await createSecureSession(c, user, 'email');

    // Set an HttpOnly secure cookie for the session. Use COOKIE_DOMAIN env if present, otherwise default to .quietterminal.co.uk
    try {
      const domain = c.env.COOKIE_DOMAIN || '.quietterminal.co.uk';
      const cookie = `qti_token=${sessionToken}; Path=/; Domain=${domain}; HttpOnly; Secure; SameSite=Lax; Max-Age=${CONFIG.SESSION_DURATION}`;
      c.header('Set-Cookie', cookie);
    } catch (e) {
      // If headers can't be set for some reason, continue — token will still be returned in body
      console.error('Failed to set cookie:', e);
    }

    return c.json({
      needs_username: true,
      user: { id: user.id, email: user.email },
      token: sessionToken,
    });
  }

  const { token: sessionToken } = await createSecureSession(c, user, 'email');

  // Set cookie for authenticated session
  try {
    const domain = c.env.COOKIE_DOMAIN || '.quietterminal.co.uk';
    const cookie = `qti_token=${sessionToken}; Path=/; Domain=${domain}; HttpOnly; Secure; SameSite=Lax; Max-Age=${CONFIG.SESSION_DURATION}`;
    c.header('Set-Cookie', cookie);
  } catch (e) {
    console.error('Failed to set cookie:', e);
  }

  return c.json({ token: sessionToken, user });
});

// ============================================================================
// AGE VERIFICATION (POST-OAUTH)
// ============================================================================

app.post('/auth/age/verify', async (c) => {
  const { temp_token, date_of_birth } = await c.req.json();
  const db = c.env.DB;

  if (!temp_token) {
    return c.json({ error: 'Missing temp_token' }, 400);
  }

  if (!isValidDateOfBirth(date_of_birth)) {
    return c.json({ error: 'Invalid date of birth' }, 400);
  }

  // Lookup temporary OAuth data
  const { results: temps } = await db.prepare(
    'SELECT * FROM oauth_temp WHERE id = ?'
  ).bind(temp_token).all();

  if (temps.length === 0) {
    return c.json({ error: 'Invalid or expired temp token' }, 400);
  }

  const temp = temps[0];
  const age = calculateAge(date_of_birth);
  const emailNorm = normalizeEmail(temp.email);

  // Check account limit before creating new user
  const { results: existingCount } = await db.prepare(
    'SELECT COUNT(*) as count FROM users WHERE email_normalized = ?'
  ).bind(emailNorm).all();

  if (existingCount[0].count >= CONFIG.MAX_ACCOUNTS_PER_EMAIL) {
    return c.json({ error: 'This email already has the maximum number of accounts' }, 400);
  }

  // Create new user from OAuth temp data
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

  // Clean up temp entry
  await db.prepare('DELETE FROM oauth_temp WHERE id = ?').bind(temp_token).run();

  const user = { id: userId, email: temp.email, role: 'user', is_child: age < 18, username_original: null };

  // Create secure session token and set cookie
  const { token: sessionToken } = await createSecureSession(c, user, `oauth_${temp.provider}`);
  try {
    const domain = c.env.COOKIE_DOMAIN || '.quietterminal.co.uk';
    const cookie = `qti_token=${sessionToken}; Path=/; Domain=${domain}; HttpOnly; Secure; SameSite=Lax; Max-Age=${CONFIG.SESSION_DURATION}`;
    c.header('Set-Cookie', cookie);
  } catch (e) {
    console.error('Failed to set cookie on age verify:', e);
  }

  // If user has no username, instruct frontend to prompt for username and return token
  if (!user.username_original) {
    return c.json({ needs_username: true, user: { id: user.id, email: user.email }, token: sessionToken });
  }

  return c.json({ token: sessionToken, user });
});

// ============================================================================
// USERNAME ROUTES
// ============================================================================

app.post('/username/claim', authMiddleware, async (c) => {
  const user = c.get('user');
  const { username } = await c.req.json();
  const db = c.env.DB;

  // Check if user already has username
  const { results: existing } = await db.prepare(
    'SELECT username_original FROM users WHERE id = ?'
  ).bind(user.user_id).all();

  if (existing[0]?.username_original) {
    return c.json({ error: 'Username already claimed' }, 400);
  }

  // Validate username
  const validationErrors = validateUsername(username);
  if (validationErrors.length > 0) {
    return c.json({ error: validationErrors[0] }, 400);
  }

  // Check profanity
  const profanityCheck = await checkProfanity(username, db);
  if (profanityCheck.isProfane) {
    return c.json({ error: 'Username contains prohibited words' }, 400);
  }

  // Check uniqueness
  const canonical = normalizeUsername(username);
  const { results: duplicates } = await db.prepare(
    'SELECT id FROM users WHERE username_canonical = ?'
  ).bind(canonical).all();

  if (duplicates.length > 0) {
    return c.json({ error: 'Username unavailable' }, 400);
  }

  // Claim username
  await db.prepare(`
    UPDATE users 
    SET username_original = ?, username_canonical = ?, updated_at = ?
    WHERE id = ?
  `).bind(username, canonical, now(), user.user_id).run();

  // Log in username history
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

  // Validate new username
  const validationErrors = validateUsername(new_username);
  if (validationErrors.length > 0) {
    return c.json({ error: validationErrors[0] }, 400);
  }

  // Check profanity
  const profanityCheck = await checkProfanity(new_username, db);
  if (profanityCheck.isProfane) {
    return c.json({ error: 'Username contains prohibited words' }, 400);
  }

  // Check cooldown (unless admin override)
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

      // Check yearly limit
      const currentYear = new Date().getFullYear();
      if (cd.year === currentYear && cd.change_count_this_year >= CONFIG.MAX_USERNAME_CHANGES_PER_YEAR) {
        return c.json({ error: 'You have reached the maximum number of username changes this year' }, 400);
      }
    }
  }

  // Check uniqueness
  const canonical = normalizeUsername(new_username);
  const { results: duplicates } = await db.prepare(
    'SELECT id FROM users WHERE username_canonical = ? AND id != ?'
  ).bind(canonical, user.user_id).all();

  if (duplicates.length > 0) {
    return c.json({ error: 'Username unavailable' }, 400);
  }

  // Get old username
  const { results: userData } = await db.prepare(
    'SELECT username_original FROM users WHERE id = ?'
  ).bind(user.user_id).all();

  const oldUsername = userData[0].username_original;

  // Update username
  await db.prepare(`
    UPDATE users 
    SET username_original = ?, username_canonical = ?, updated_at = ?
    WHERE id = ?
  `).bind(new_username, canonical, now(), user.user_id).run();

  // Log change
  await db.prepare(`
    INSERT INTO username_history (user_id, old_username, new_username, changed_at, changed_reason)
    VALUES (?, ?, ?, ?, ?)
  `).bind(user.user_id, oldUsername, new_username, now(), 'user_change').run();

  // Update cooldown
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

// ============================================================================
// USER ROUTES
// ============================================================================

app.get('/me', authMiddleware, async (c) => {
  const user = c.get('user');
  const db = c.env.DB;

  const { results } = await db.prepare(
    'SELECT id, username_original, email, role, is_child, date_of_birth, created_at FROM users WHERE id = ?'
  ).bind(user.user_id).all();

  return c.json({ user: results[0] });
});

app.post('/logout', authMiddleware, async (c) => {
  const db = c.env.DB;
  const session = c.get('session');

  // Revoke the session in database
  if (session?.id) {
    try {
      await db.prepare(
        'UPDATE user_sessions SET revoked_at = ? WHERE id = ?'
      ).bind(now(), session.id).run();
    } catch (e) {
      console.error('Failed to revoke session:', e);
    }
  }

  // Clear cookie
  try {
    const domain = c.env.COOKIE_DOMAIN || '.quietterminal.co.uk';
    const cookie = `qti_token=deleted; Path=/; Domain=${domain}; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
    c.header('Set-Cookie', cookie);
  } catch (e) {
    console.error('Failed to clear cookie on logout:', e);
  }

  return c.json({ message: 'Logged out' });
});

// ============================================================================
// REPORTING ROUTES (UK OSA COMPLIANCE)
// ============================================================================

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

  // Determine priority based on type
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

  // Update daily stats
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

// ============================================================================
// MODERATION ROUTES (ADMIN ONLY)
// ============================================================================

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

  // Create moderation action
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

  // Apply action
  if (action_type === 'ban') {
    await db.prepare(`
      UPDATE users
      SET is_banned = 1, ban_reason = ?, banned_at = ?, banned_by = ?
      WHERE id = ?
    `).bind(reason, now(), admin.user_id, user_id).run();

    // Update stats
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

  // Update report status if linked
  if (report_id) {
    await db.prepare(`
      UPDATE user_reports
      SET status = 'actioned', reviewed_at = ?, reviewed_by = ?, updated_at = ?
      WHERE id = ?
    `).bind(now(), admin.user_id, now(), report_id).run();

    // Update stats
    await db.prepare(`
      INSERT INTO daily_stats (date, reports_actioned, updated_at)
      VALUES (date('now'), 1, ?)
      ON CONFLICT(date) DO UPDATE SET
        reports_actioned = reports_actioned + 1,
        updated_at = excluded.updated_at
    `).bind(now()).run();
  }

  // Log admin action
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

// ============================================================================
// ADMIN ROUTES
// ============================================================================

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

// ============================================================================
// SESSION MANAGEMENT ROUTES
// ============================================================================

// Get user's active sessions
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

  // Mark current session
  const sessionsWithCurrent = sessions.map(s => ({
    ...s,
    is_current: currentSession?.id === s.id,
  }));

  return c.json({ sessions: sessionsWithCurrent });
});

// Revoke a specific session
app.post('/sessions/:sessionId/revoke', authMiddleware, async (c) => {
  const user = c.get('user');
  const sessionId = c.req.param('sessionId');
  const db = c.env.DB;

  // Verify session belongs to user
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

// Revoke all sessions except current
app.post('/sessions/revoke-all', authMiddleware, async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const currentSession = c.get('session');

  // Revoke all sessions except current
  await db.prepare(`
    UPDATE user_sessions
    SET revoked_at = ?
    WHERE user_id = ? AND revoked_at IS NULL AND id != ?
  `).bind(now(), user.user_id, currentSession?.id || '').run();

  return c.json({ message: 'All other sessions revoked' });
});

// Admin: View security events for a user
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

// Admin: Revoke all sessions for a user (force logout)
app.post('/admin/users/:userId/revoke-sessions', authMiddleware, adminMiddleware, async (c) => {
  const admin = c.get('user');
  const userId = c.req.param('userId');
  const db = c.env.DB;

  await db.prepare(`
    UPDATE user_sessions
    SET revoked_at = ?
    WHERE user_id = ? AND revoked_at IS NULL
  `).bind(now(), userId).run();

  // Log admin action
  await db.prepare(`
    INSERT INTO admin_logs (id, admin_id, action, target_id, target_type, details, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(generateId(), admin.user_id, 'revoke_all_sessions', userId, 'user', '{}', now()).run();

  return c.json({ message: 'All user sessions revoked' });
});

// ============================================================================
// GAME STATS ROUTES
// ============================================================================

// Get all games
app.get('/games', authMiddleware, async (c) => {
  const user = c.get('user');
  const db = c.env.DB;

  // Filter games based on user role - admins see all games, normal users only see non-admin games
  const whereClause = user.role === 'admin'
    ? 'WHERE is_active = 1'
    : 'WHERE is_active = 1 AND (admin_only IS NULL OR admin_only = 0)';

  const { results: games } = await db.prepare(
    `SELECT id, name, slug, description, icon_url, is_active FROM games ${whereClause} ORDER BY name`
  ).all();

  return c.json({ games });
});

// Get user's stats for a specific game
app.get('/games/:gameSlug/stats', authMiddleware, async (c) => {
  const user = c.get('user');
  const gameSlug = c.req.param('gameSlug');
  const db = c.env.DB;

  // Get game info
  const { results: games } = await db.prepare(
    'SELECT * FROM games WHERE slug = ? AND is_active = 1'
  ).bind(gameSlug).all();

  if (games.length === 0) {
    return c.json({ error: 'Game not found' }, 404);
  }

  const game = games[0];

  // Check if game is admin-only and user is not an admin
  if (game.admin_only && user.role !== 'admin') {
    return c.json({ error: 'Forbidden: This game is only accessible to admins' }, 403);
  }

  // Get user's achievements for this game
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

  // Get user's game stats
  const { results: stats } = await db.prepare(
    'SELECT * FROM user_game_stats WHERE user_id = ? AND game_id = ?'
  ).bind(user.user_id, game.id).all();

  const userStats = stats.length > 0 ? JSON.parse(stats[0].stats_data || '{}') : {};

  // Calculate achievement progress
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

// Admin: Create/update game
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

// Admin: Create achievement
app.post('/admin/games/:gameSlug/achievements', authMiddleware, adminMiddleware, async (c) => {
  const gameSlug = c.req.param('gameSlug');
  const { name, description, icon_url, points } = await c.req.json();
  const db = c.env.DB;

  // Get game
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

// ============================================================================
// JAGSMP - MINECRAFT ACCOUNT LINKING
// ============================================================================

// Generate a new link code (called by Minecraft plugin via /qtilink command)
app.post('/jagsmp/generate-code', async (c) => {
  const { plugin_secret, minecraft_uuid, minecraft_username } = await c.req.json();
  const db = c.env.DB;

  // Verify plugin secret
  if (plugin_secret !== c.env.MINECRAFT_PLUGIN_SECRET) {
    return c.json({ error: 'Invalid plugin secret' }, 401);
  }

  if (!minecraft_uuid || !minecraft_username) {
    return c.json({ error: 'minecraft_uuid and minecraft_username are required' }, 400);
  }

  // Generate a unique 6-character code
  const code = generateLinkCode();
  const codeId = generateId();
  const now_ts = now();
  const expiresAt = now_ts + (10 * 60); // 10 minutes expiry

  // Check if this Minecraft account is already linked
  const { results: existingLinks } = await db.prepare(
    'SELECT user_id FROM minecraft_accounts WHERE minecraft_uuid = ?'
  ).bind(minecraft_uuid).all();

  if (existingLinks.length > 0) {
    return c.json({ error: 'This Minecraft account is already linked', already_linked: true }, 400);
  }

  // Check if there's a pending code for this UUID
  const { results: existingCodes } = await db.prepare(
    'SELECT id FROM minecraft_link_codes WHERE minecraft_uuid = ? AND used = 0 AND expires_at > ?'
  ).bind(minecraft_uuid, now_ts).all();

  // Delete old codes for this UUID
  if (existingCodes.length > 0) {
    await db.prepare('DELETE FROM minecraft_link_codes WHERE minecraft_uuid = ?').bind(minecraft_uuid).run();
  }

  // Insert new code
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

// Verify and link code (called by website when user enters code)
app.post('/jagsmp/link', authMiddleware, async (c) => {
  const { code } = await c.req.json();
  const db = c.env.DB;
  const user = c.get('user');
  const userId = user.user_id;
  const now_ts = now();

  if (!code) {
    return c.json({ error: 'Code is required' }, 400);
  }

  // Check if user already has a linked account
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

  // Check cooldown
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

  // Find and validate code
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

  // Check if this Minecraft account is already linked to another user
  const { results: existingLinks } = await db.prepare(
    'SELECT user_id FROM minecraft_accounts WHERE minecraft_uuid = ?'
  ).bind(linkCode.minecraft_uuid).all();

  if (existingLinks.length > 0) {
    return c.json({ error: 'This Minecraft account is already linked to another user' }, 400);
  }

  // Link the account
  const linkId = generateId();
  await db.prepare(`
    INSERT INTO minecraft_accounts (id, user_id, minecraft_uuid, minecraft_username, linked_at, last_updated)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(linkId, userId, linkCode.minecraft_uuid, linkCode.minecraft_username, now_ts, now_ts).run();

  // Mark code as used
  await db.prepare(
    'UPDATE minecraft_link_codes SET used = 1, used_by_user_id = ?, used_at = ? WHERE id = ?'
  ).bind(userId, now_ts, linkCode.id).run();

  // Initialize player stats
  const statsId = generateId();
  await db.prepare(`
    INSERT INTO minecraft_player_stats (id, minecraft_uuid, first_joined, last_updated)
    VALUES (?, ?, ?, ?)
  `).bind(statsId, linkCode.minecraft_uuid, now_ts, now_ts).run();

  // Log activity
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

// Unlink Minecraft account
app.post('/jagsmp/unlink', authMiddleware, async (c) => {
  const db = c.env.DB;
  const user = c.get('user');
  const userId = user.user_id;
  const now_ts = now();

  // Get linked account
  const { results: links } = await db.prepare(
    'SELECT minecraft_uuid, minecraft_username FROM minecraft_accounts WHERE user_id = ?'
  ).bind(userId).all();

  if (links.length === 0) {
    return c.json({ error: 'No linked Minecraft account found' }, 404);
  }

  const link = links[0];

  // Create cooldown record (7 days)
  const cooldownId = generateId();
  const canLinkAgainAt = now_ts + (7 * 24 * 60 * 60); // 7 days

  await db.prepare(`
    INSERT INTO minecraft_unlink_cooldowns (id, user_id, unlinked_at, can_link_again_at, previous_minecraft_uuid, previous_minecraft_username)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(cooldownId, userId, now_ts, canLinkAgainAt, link.minecraft_uuid, link.minecraft_username).run();

  // Delete the link (this will cascade delete stats and achievements due to foreign keys)
  await db.prepare('DELETE FROM minecraft_accounts WHERE user_id = ?').bind(userId).run();

  return c.json({
    message: 'Minecraft account unlinked successfully',
    cooldown_ends_at: canLinkAgainAt,
    can_link_again_in_days: 7
  });
});

// Get user's linked Minecraft account and stats
app.get('/jagsmp/me', authMiddleware, async (c) => {
  const db = c.env.DB;
  const user = c.get('user');
  const userId = user.user_id;

  // Get linked account
  const { results: links } = await db.prepare(`
    SELECT minecraft_uuid, minecraft_username, linked_at, last_updated
    FROM minecraft_accounts
    WHERE user_id = ?
  `).bind(userId).all();

  if (links.length === 0) {
    return c.json({ linked: false, account: null });
  }

  const link = links[0];

  // Get player stats
  const { results: stats } = await db.prepare(`
    SELECT * FROM minecraft_player_stats WHERE minecraft_uuid = ?
  `).bind(link.minecraft_uuid).all();

  // Get achievements
  const { results: achievements } = await db.prepare(`
    SELECT ma.*, mpa.unlocked_at
    FROM minecraft_player_achievements mpa
    JOIN minecraft_achievements ma ON mpa.achievement_id = ma.id
    WHERE mpa.minecraft_uuid = ?
    ORDER BY mpa.unlocked_at DESC
  `).bind(link.minecraft_uuid).all();

  // Get recent activity
  const { results: activity } = await db.prepare(`
    SELECT activity_type, activity_data, occurred_at
    FROM minecraft_activity_log
    WHERE minecraft_uuid = ?
    ORDER BY occurred_at DESC
    LIMIT 20
  `).bind(link.minecraft_uuid).all();

  // Calculate KDR
  const playerStats = stats[0] || {};
  const kills = playerStats.player_kills || 0;
  const deaths = playerStats.deaths || 0;
  const kdr = deaths > 0 ? (kills / deaths).toFixed(2) : kills.toFixed(2);

  // Calculate total achievement points
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

// Get all available achievements
app.get('/jagsmp/achievements', async (c) => {
  const db = c.env.DB;

  const { results: achievements } = await db.prepare(`
    SELECT * FROM minecraft_achievements
    WHERE is_secret = 0
    ORDER BY category, points ASC
  `).all();

  // Group by category
  const grouped = achievements.reduce((acc, ach) => {
    const category = ach.category || 'general';
    if (!acc[category]) acc[category] = [];
    acc[category].push(ach);
    return acc;
  }, {});

  return c.json({ achievements: grouped });
});

// Plugin endpoint: Update player stats
app.post('/jagsmp/plugin/update-stats', async (c) => {
  const { plugin_secret, minecraft_uuid, stats } = await c.req.json();
  const db = c.env.DB;

  // Verify plugin secret
  if (plugin_secret !== c.env.MINECRAFT_PLUGIN_SECRET) {
    return c.json({ error: 'Invalid plugin secret' }, 401);
  }

  if (!minecraft_uuid || !stats) {
    return c.json({ error: 'minecraft_uuid and stats are required' }, 400);
  }

  const now_ts = now();

  // Update or insert stats
  const { results: existing } = await db.prepare(
    'SELECT id FROM minecraft_player_stats WHERE minecraft_uuid = ?'
  ).bind(minecraft_uuid).all();

  if (existing.length > 0) {
    // Update existing stats
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
    // Insert new stats
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

// Plugin endpoint: Log activity
app.post('/jagsmp/plugin/log-activity', async (c) => {
  const { plugin_secret, minecraft_uuid, activity_type, activity_data } = await c.req.json();
  const db = c.env.DB;

  // Verify plugin secret
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

// Plugin endpoint: Unlock achievement
app.post('/jagsmp/plugin/unlock-achievement', async (c) => {
  const { plugin_secret, minecraft_uuid, achievement_key } = await c.req.json();
  const db = c.env.DB;

  // Verify plugin secret
  if (plugin_secret !== c.env.MINECRAFT_PLUGIN_SECRET) {
    return c.json({ error: 'Invalid plugin secret' }, 401);
  }

  if (!minecraft_uuid || !achievement_key) {
    return c.json({ error: 'minecraft_uuid and achievement_key are required' }, 400);
  }

  // Get achievement
  const { results: achievements } = await db.prepare(
    'SELECT id, name, points FROM minecraft_achievements WHERE achievement_key = ?'
  ).bind(achievement_key).all();

  if (achievements.length === 0) {
    return c.json({ error: 'Achievement not found' }, 404);
  }

  const achievement = achievements[0];

  // Check if already unlocked
  const { results: unlocked } = await db.prepare(
    'SELECT id FROM minecraft_player_achievements WHERE minecraft_uuid = ? AND achievement_id = ?'
  ).bind(minecraft_uuid, achievement.id).all();

  if (unlocked.length > 0) {
    return c.json({ message: 'Achievement already unlocked', already_unlocked: true });
  }

  // Unlock achievement
  const unlockId = generateId();
  const now_ts = now();

  await db.prepare(`
    INSERT INTO minecraft_player_achievements (id, minecraft_uuid, achievement_id, unlocked_at)
    VALUES (?, ?, ?, ?)
  `).bind(unlockId, minecraft_uuid, achievement.id, now_ts).run();

  // Log activity
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

// Helper function to generate random 6-character link code
function generateLinkCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Excluded confusing chars: I, O, 0, 1
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// ============================================================================
// HEALTH CHECK
// ============================================================================

app.get('/health', (c) => {
  return c.json({ status: 'ok', timestamp: now() });
});

// ============================================================================
// EXPORT
// ============================================================================

export default app;
