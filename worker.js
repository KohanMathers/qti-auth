import { handleScheduled } from './src/cron.js';
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

    REPORT_REVIEW_SLA: 24 * 60 * 60,

    // Session security
    MAX_SESSIONS_PER_USER: 10, // Limit concurrent sessions per user
    LEGACY_TOKEN_DEADLINE: 1737331200, // 2025-01-20 00:00:00 UTC - after this, legacy tokens are rejected
    SECURITY_EVENT_RATE_LIMIT: 10, // Max security events per user per hour
    SECURITY_ALERT_RATE_LIMIT: 3, // Max security alert emails per user per hour

    // OAuth 2.1 / OpenID Connect Provider settings
    OAUTH_PROVIDER: {
        AUTH_CODE_EXPIRY: 10 * 60,           // 10 minutes
        ACCESS_TOKEN_EXPIRY: 60 * 60,        // 1 hour
        REFRESH_TOKEN_EXPIRY: 30 * 24 * 60 * 60, // 30 days
        ID_TOKEN_EXPIRY: 60 * 60,            // 1 hour
        SUPPORTED_SCOPES: ['openid', 'profile', 'email'],
        SUPPORTED_RESPONSE_TYPES: ['code'],
        SUPPORTED_GRANT_TYPES: ['authorization_code', 'refresh_token'],
        SUPPORTED_CODE_CHALLENGE_METHODS: ['S256'],
    },

    GAME_LEASE_DURATION: 20 * 24 * 60 * 60, // 20 days in seconds
};

const BRANDING_DEFAULTS = {
    brandName: 'QTI',
    companyName: 'Quiet Terminal Interactive',
    apiUrl: 'https://auth.quietterminal.co.uk',
    frontendUrl: 'https://account.quietterminal.co.uk',
    cookieDomain: '.quietterminal.co.uk',
    oauthRedirectUri: 'https://auth.quietterminal.co.uk/auth/oauth/callback',
    corsOrigins: [
        'https://account.quietterminal.co.uk',
        'https://account-staging.quietterminal.co.uk',
        'https://support.quietterminal.co.uk',
        'https://support-staging.quietterminal.co.uk',
    ],
    securitySenderName: 'QTI Security',
    securitySenderEmail: 'security@account.quietterminal.co.uk',
    authSenderName: 'QTI Auth',
    authSenderEmail: 'auth@account.quietterminal.co.uk',
    serviceDocumentationUrl: 'https://quietterminal.co.uk/docs/oauth',
};

function parseCsvList(value, fallback) {
    if (!value || typeof value !== 'string') return fallback;
    const parsed = value
        .split(',')
        .map(v => v.trim())
        .filter(Boolean);
    return parsed.length > 0 ? parsed : fallback;
}

function getBranding(c) {
    return {
        brandName: c.env.BRAND_NAME || BRANDING_DEFAULTS.brandName,
        companyName: c.env.COMPANY_NAME || BRANDING_DEFAULTS.companyName,
        apiUrl: c.env.API_URL || BRANDING_DEFAULTS.apiUrl,
        frontendUrl: c.env.FRONTEND_URL || BRANDING_DEFAULTS.frontendUrl,
        cookieDomain: c.env.COOKIE_DOMAIN || BRANDING_DEFAULTS.cookieDomain,
        oauthRedirectUri: (c.env.OAUTH_REDIRECT_URI || BRANDING_DEFAULTS.oauthRedirectUri).trim(),
        corsOrigins: parseCsvList(c.env.CORS_ORIGINS, BRANDING_DEFAULTS.corsOrigins),
        securitySenderName: c.env.SECURITY_SENDER_NAME || BRANDING_DEFAULTS.securitySenderName,
        securitySenderEmail: c.env.SECURITY_SENDER_EMAIL || BRANDING_DEFAULTS.securitySenderEmail,
        authSenderName: c.env.AUTH_SENDER_NAME || BRANDING_DEFAULTS.authSenderName,
        authSenderEmail: c.env.AUTH_SENDER_EMAIL || BRANDING_DEFAULTS.authSenderEmail,
        serviceDocumentationUrl: c.env.SERVICE_DOCUMENTATION_URL || BRANDING_DEFAULTS.serviceDocumentationUrl,
    };
}

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

function slugify(value) {
    return value
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
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
// OAUTH 2.1 / OPENID CONNECT PROVIDER UTILITIES
// ============================================================================

// Base64URL encode (no padding, URL-safe)
function base64UrlEncode(data) {
    const base64 = btoa(String.fromCharCode(...new Uint8Array(data)));
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function base64UrlEncodeString(str) {
    const encoder = new TextEncoder();
    return base64UrlEncode(encoder.encode(str));
}

function base64UrlDecode(str) {
    const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
    const padding = '='.repeat((4 - base64.length % 4) % 4);
    const decoded = atob(base64 + padding);
    return new Uint8Array([...decoded].map(c => c.charCodeAt(0)));
}

// Import RSA private key from PEM format for signing
async function importPrivateKey(pemKey) {
    const pemContents = pemKey
        .replace(/-----BEGIN PRIVATE KEY-----/, '')
        .replace(/-----END PRIVATE KEY-----/, '')
        .replace(/\s/g, '');
    const binaryKey = base64UrlDecode(pemContents.replace(/\+/g, '-').replace(/\//g, '_'));

    return await crypto.subtle.importKey(
        'pkcs8',
        binaryKey,
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['sign']
    );
}

// Import RSA public key from PEM format for verification
async function importPublicKey(pemKey) {
    const pemContents = pemKey
        .replace(/-----BEGIN PUBLIC KEY-----/, '')
        .replace(/-----END PUBLIC KEY-----/, '')
        .replace(/\s/g, '');
    const binaryKey = base64UrlDecode(pemContents.replace(/\+/g, '-').replace(/\//g, '_'));

    return await crypto.subtle.importKey(
        'spki',
        binaryKey,
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        true,
        ['verify']
    );
}

// Sign JWT with RS256
async function signJwtRS256(payload, privateKeyPem) {
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

// Generate at_hash (access token hash for ID token)
async function generateAtHash(accessToken) {
    const encoder = new TextEncoder();
    const hash = await crypto.subtle.digest('SHA-256', encoder.encode(accessToken));
    // Take left-most half of hash and base64url encode
    const halfHash = new Uint8Array(hash).slice(0, 16);
    return base64UrlEncode(halfHash);
}

// Verify PKCE code_verifier against code_challenge (S256 only per OAuth 2.1)
async function verifyPKCE(codeVerifier, codeChallenge) {
    const encoder = new TextEncoder();
    const hash = await crypto.subtle.digest('SHA-256', encoder.encode(codeVerifier));
    const computedChallenge = base64UrlEncode(hash);
    return computedChallenge === codeChallenge;
}

// Generate secure random token
function generateSecureToken(length = 32) {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return base64UrlEncode(bytes);
}

// Get issuer URL based on environment
function getIssuer(c) {
    return getBranding(c).apiUrl;
}

// Build user claims based on requested scopes
function buildUserClaims(user, scopes) {
    const claims = {};

    // openid scope - always include sub
    if (scopes.includes('openid')) {
        claims.sub = user.id;
    }

    // profile scope
    if (scopes.includes('profile')) {
        claims.name = user.username_original;
        claims.preferred_username = user.username_original;
        claims.updated_at = user.updated_at;
        // picture could be added if we have avatar support
    }

    // email scope
    if (scopes.includes('email')) {
        claims.email = user.email;
        claims.email_verified = true; // All our emails are verified via magic link or OAuth
    }

    return claims;
}

// Validate redirect URI against registered URIs (exact match per OAuth 2.1)
function validateRedirectUri(redirectUri, registeredUris) {
    try {
        const uris = JSON.parse(registeredUris);
        return uris.includes(redirectUri);
    } catch {
        return false;
    }
}

// Validate requested scopes against client's allowed scopes
function validateScopes(requestedScopes, allowedScopes) {
    try {
        const allowed = JSON.parse(allowedScopes);
        const requested = requestedScopes.split(' ').filter(s => s);
        return requested.every(scope => allowed.includes(scope));
    } catch {
        return false;
    }
}

// ============================================================================
// SESSION SECURITY - FINGERPRINTING & VALIDATION
// ============================================================================

// Extract /24 subnet from IP address (e.g., "192.168.1.100" -> "192.168.1")
// For IPv6, extracts /48 subnet properly handling compressed addresses
function getIPSubnet(ip) {
    if (!ip || ip === 'unknown') return 'unknown';

    // Handle IPv4
    const parts = ip.split('.');
    if (parts.length === 4) {
        return parts.slice(0, 3).join('.');
    }

    // Handle IPv6 - expand compressed addresses and use first 48 bits (3 groups)
    // First, check if it's an IPv4-mapped IPv6 address (::ffff:192.168.1.1)
    if (ip.toLowerCase().startsWith('::ffff:')) {
        const ipv4Part = ip.substring(7);
        const ipv4Parts = ipv4Part.split('.');
        if (ipv4Parts.length === 4) {
            return ipv4Parts.slice(0, 3).join('.');
        }
    }

    // Expand compressed IPv6 address
    let expanded = ip;
    if (ip.includes('::')) {
        const [left, right] = ip.split('::');
        const leftParts = left ? left.split(':') : [];
        const rightParts = right ? right.split(':') : [];
        const missing = 8 - leftParts.length - rightParts.length;
        const middle = Array(missing).fill('0000');
        expanded = [...leftParts, ...middle, ...rightParts].join(':');
    }

    // Normalize each group to 4 digits and take first 3 groups for /48
    const groups = expanded.split(':');
    if (groups.length >= 3) {
        return groups.slice(0, 3).map(g => g.padStart(4, '0')).join(':');
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

    // FALLBACK: If user-agent matches and client-side fingerprint data wasn't sent
    // (timezone, screen, browserFingerprint are all null), allow with reduced trust.
    // This handles the case where the frontend isn't sending fingerprint headers yet.
    const clientFingerprintMissing = !currentFingerprint.timezone &&
        !currentFingerprint.screenResolution &&
        !currentFingerprint.browserFingerprint;
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

// Log security event with rate limiting to prevent DoS via event flooding
async function logSecurityEvent(db, eventType, sessionId, userId, ip, country, details) {
    try {
        // Rate limit security events per user (max 10 per hour)
        if (userId) {
            const hourAgo = now() - 3600;
            const { results } = await db.prepare(
                'SELECT COUNT(*) as count FROM session_security_events WHERE user_id = ? AND created_at > ?'
            ).bind(userId, hourAgo).all();

            if (results[0].count >= CONFIG.SECURITY_EVENT_RATE_LIMIT) {
                console.warn(`Security event rate limit exceeded for user ${userId}`);
                return; // Skip logging to prevent table bloat
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

// Send security alert email (for suspicious activity) with rate limiting
async function sendSecurityAlert(c, user, eventType, details) {
    if (!c.env.EMAIL_SERVICE_API_KEY || !user.email) return;

    const db = c.env.DB;
    const branding = getBranding(c);

    // Rate limit security alert emails per user (max 3 per hour)
    try {
        const rateCheck = await checkRateLimit(
            db,
            `security_alert:${user.email}`,
            CONFIG.SECURITY_ALERT_RATE_LIMIT,
            3600
        );

        if (!rateCheck.allowed) {
            console.warn(`Security alert rate limit exceeded for ${user.email}`);
            return; // Skip sending to prevent email flooding
        }
    } catch (e) {
        console.error('Failed to check security alert rate limit:', e);
        // Continue anyway - better to potentially spam than miss a real alert
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
                sender: { name: branding.securitySenderName, email: branding.securitySenderEmail },
                to: [{ email: user.email }],
                subject: `Security Alert: Suspicious login attempt on your ${branding.brandName} account`,
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
              &copy; ${new Date().getFullYear()} ${branding.companyName}
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
    // Fix: Check fingerprint.userAgent is truthy before hashing
    const userAgentHash = fingerprint.userAgent
        ? await hashToken(fingerprint.userAgent)
        : null;

    try {
        // Enforce session limit per user - delete oldest sessions if at limit
        const { results: existingSessions } = await db.prepare(`
      SELECT id FROM user_sessions
      WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
      ORDER BY created_at ASC
    `).bind(user.id, now()).all();

        if (existingSessions.length >= CONFIG.MAX_SESSIONS_PER_USER) {
            // Revoke oldest sessions to make room
            const sessionsToRevoke = existingSessions.slice(0, existingSessions.length - CONFIG.MAX_SESSIONS_PER_USER + 1);
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

app.use('/*', cors({
    origin: (origin, c) => {
        const { corsOrigins } = getBranding(c);
        if (!origin) return corsOrigins[0] || '*';
        return corsOrigins.includes(origin) ? origin : '';
    },
    credentials: true,
}));

// Auth middleware with session fingerprint validation
const authMiddleware = async (c, next) => {
    try {
        // Accept token from Authorization header or cookie named `qti_token`
        let token = c.req.header('Authorization')?.replace('Bearer ', '');
        const cookieHeader = c.req.header('cookie') || '';
        if (!token) {
            const match = cookieHeader.match(/(?:^|; )qti_token=([^;]+)/);
            if (match) token = match[1];
        }
        const requestPath = new URL(c.req.url).pathname;
        console.log('[authMiddleware] path:', requestPath, 'hasToken:', !!token, 'cookieHeader:', cookieHeader.slice(0, 80));
        if (!token) {
            const wantsHtml = (c.req.header('accept') || '').includes('text/html');
            if (requestPath === '/oauth/authorize' && wantsHtml) {
                const frontendUrl = c.env.FRONTEND_URL || 'https://account.quietterminal.co.uk';
                const loginUrl = new URL(`${frontendUrl}/login`);
                loginUrl.searchParams.set('redirect', c.req.url);
                console.log('[authMiddleware] no token, redirecting to login');
                return c.redirect(loginUrl.toString());
            }
            return c.json({ error: 'Unauthorized' }, 401);
        }

        let payload;
        try {
            payload = await verify(token, CONFIG.JWT_SECRET, "HS256");
        } catch (e) {
            console.log('[authMiddleware] JWT verify failed:', String(e));
            const wantsHtml = (c.req.header('accept') || '').includes('text/html');
            if (requestPath === '/oauth/authorize' && wantsHtml) {
                const frontendUrl = c.env.FRONTEND_URL || 'https://account.quietterminal.co.uk';
                const loginUrl = new URL(`${frontendUrl}/login`);
                loginUrl.searchParams.set('redirect', c.req.url);
                return c.redirect(loginUrl.toString());
            }
            return c.json({ error: 'Unauthorized' }, 401);
        }
        const db = c.env.DB;
        const currentTime = now();

        // Look up session by token hash
        const tokenHash = await hashToken(token);
        const { results: sessions } = await db.prepare(
            'SELECT * FROM user_sessions WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?'
        ).bind(tokenHash, currentTime).all();

        console.log('[authMiddleware] user_id:', payload.user_id, 'sessions found:', sessions.length);

        // If no session found, this is a legacy token or session was revoked
        if (sessions.length === 0) {
            // Check if legacy token deadline has passed
            if (currentTime > CONFIG.LEGACY_TOKEN_DEADLINE) {
                console.log('[authMiddleware] legacy token deadline passed');
                return c.json({
                    error: 'Session expired. Please sign in again.',
                    code: 'LEGACY_TOKEN_EXPIRED',
                    requires_reauth: true,
                }, 401);
            }

            // For backwards compatibility during migration, allow tokens without session records
            // but indicate re-auth is needed soon
            c.set('user', payload);
            c.set('session', null);
            c.set('session_trust', 'legacy');
            c.set('legacy_reauth_recommended', true);
            await next();
            return;
        }

        const session = sessions[0];

        // Check if user is banned or locked
        const { results: userStatus } = await db.prepare(
            'SELECT is_banned, is_locked, lock_expires_at FROM users WHERE id = ?'
        ).bind(payload.user_id).all();

        if (userStatus.length > 0) {
            const currentTime = now();
            const userRecord = userStatus[0];
            const requestPath = new URL(c.req.url).pathname;
            const allowRestrictedSupport = requestPath === '/support/tickets' && c.req.method === 'POST';

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
                // Check if lock has expired
                if (userRecord.lock_expires_at && userRecord.lock_expires_at <= currentTime) {
                    // Lock expired, clear it
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

        const currentFingerprint = collectFingerprint(c);
        console.log('[authMiddleware] fingerprint:', JSON.stringify(currentFingerprint));
        console.log('[authMiddleware] session stored:', JSON.stringify({ ip: session.ip_address, country: session.ip_country, ua: (session.user_agent_hash || '').slice(0, 8) }));

        // Validate fingerprint
        const validation = validateSessionFingerprint(session, currentFingerprint);
        console.log('[authMiddleware] fingerprint validation:', JSON.stringify(validation));

        if (!validation.valid) {
            // Get user info for alert
            const { results: users } = await db.prepare(
                'SELECT email FROM users WHERE id = ?'
            ).bind(payload.user_id).all();
            const user = users[0] || {};

            if (validation.trustLevel === 'suspicious') {
                // Different country - send email alert and block
                // Use a single atomic update to prevent race conditions
                const updateResult = await db.prepare(
                    'UPDATE user_sessions SET revoked_at = ?, trust_level = ?, flag_reason = ? WHERE id = ? AND revoked_at IS NULL'
                ).bind(currentTime, 'blocked', 'country_mismatch', session.id).run();

                // Only log and send alert if we actually revoked the session (race condition guard)
                if (updateResult.meta?.changes > 0) {
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
                }

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

        // Valid session - update last_active_at and handle partial trust in one query to reduce race conditions
        if (validation.trustLevel === 'partial' && session.trust_level !== 'partial') {
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
            // Just update last_active_at
            await db.prepare(
                'UPDATE user_sessions SET last_active_at = ? WHERE id = ?'
            ).bind(currentTime, session.id).run();
        }

        c.set('user', payload);
        c.set('session', session);
        c.set('session_trust', validation.trustLevel);
        await next();
    } catch (e) {
        console.log("authMiddleware caught:", String(e));
        console.log("authMiddleware stack:", e?.stack);
        return c.json({ error: "Auth middleware error", detail: String(e) }, 500);
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

const staffMiddleware = async (c, next) => {
    const user = c.get('user');
    if (user.role !== 'admin' && user.role !== 'support') {
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
    const redirectUri = (getBranding(c).oauthRedirectUri).trim();

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
    const redirectUri = getBranding(c).oauthRedirectUri;
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
            const redirectUri = (getBranding(c).oauthRedirectUri).trim();
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
            const redirectUri = (getBranding(c).oauthRedirectUri).trim();
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
            const redirectUri = (getBranding(c).oauthRedirectUri).trim();
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
        // Check if user is banned or locked
        if (user.is_banned) {
            const accept = c.req.header('accept') || '';
            const frontendUrl = getBranding(c).frontendUrl;
            if (accept.includes('text/html')) {
                return c.redirect(`${frontendUrl}/login?error=account_banned`);
            }
            return c.json({ error: 'Your account has been banned' }, 403);
        }

        if (user.is_locked) {
            const currentTime = now();
            if (user.lock_expires_at && user.lock_expires_at <= currentTime) {
                // Lock expired, clear it
                await db.prepare(
                    'UPDATE users SET is_locked = 0, lock_reason = NULL, locked_at = NULL, locked_by = NULL, lock_expires_at = NULL WHERE id = ?'
                ).bind(user.id).run();
            } else {
                const accept = c.req.header('accept') || '';
                const frontendUrl = getBranding(c).frontendUrl;
                if (accept.includes('text/html')) {
                    return c.redirect(`${frontendUrl}/login?error=account_locked`);
                }
                return c.json({
                    error: 'Your account has been temporarily locked',
                    lock_expires_at: user.lock_expires_at,
                }, 403);
            }
        }

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
            const frontendUrl = getBranding(c).frontendUrl;
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
            const frontendUrl = getBranding(c).frontendUrl;
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
            const domain = getBranding(c).cookieDomain;
            const cookie = `qti_token=${sessionToken}; Path=/; Domain=${domain}; HttpOnly; Secure; SameSite=None; Max-Age=${CONFIG.SESSION_DURATION}`;
            c.header('Set-Cookie', cookie);
        } catch (e) {
            console.error('Failed to set cookie on OAuth callback (needs_username):', e);
        }

        const accept = c.req.header('accept') || '';
        const frontendUrl = getBranding(c).frontendUrl;

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
        const domain = getBranding(c).cookieDomain;
        const cookie = `qti_token=${token}; Path=/; Domain=${domain}; HttpOnly; Secure; SameSite=None; Max-Age=${CONFIG.SESSION_DURATION}`;
        c.header('Set-Cookie', cookie);
    } catch (e) {
        console.error('Failed to set cookie on OAuth callback:', e);
    }

    const accept = c.req.header('accept') || '';
    const frontendUrl = getBranding(c).frontendUrl;
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
    const branding = getBranding(c);
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
    const magicLink = `${branding.frontendUrl}/verify?token=${token}`;

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
                    name: branding.authSenderName,
                    email: branding.authSenderEmail,
                },
                to: [{
                    email: email,
                    name: email.split('@')[0],
                }],
                subject: `Sign in to ${branding.brandName}`,
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
              <h1>Sign in to ${branding.brandName}</h1>
              <p>Click the button below to sign in to your ${branding.brandName} account:</p>
              <p><a href="${magicLink}" class="button">Sign In</a></p>
              <p>Or copy and paste this link into your browser:</p>
              <p style="word-break: break-all; color: #6b7280;">${magicLink}</p>
              <p><strong>This link expires in 15 minutes.</strong></p>
              <div class="footer">
                <p>If you didn't request this email, you can safely ignore it.</p>
                <p>&copy; ${new Date().getFullYear()} ${branding.companyName}. All rights reserved.</p>
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

        // Check if user is banned or locked
        if (user.is_banned) {
            return c.json({ error: 'Your account has been banned' }, 403);
        }

        if (user.is_locked) {
            const currentTime = now();
            if (user.lock_expires_at && user.lock_expires_at <= currentTime) {
                // Lock expired, clear it
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

        // Set an HttpOnly secure cookie for the session using branding-aware domain defaults.
        try {
            const domain = getBranding(c).cookieDomain;
            const cookie = `qti_token=${sessionToken}; Path=/; Domain=${domain}; HttpOnly; Secure; SameSite=None; Max-Age=${CONFIG.SESSION_DURATION}`;
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
        const domain = getBranding(c).cookieDomain;
        const cookie = `qti_token=${sessionToken}; Path=/; Domain=${domain}; HttpOnly; Secure; SameSite=None; Max-Age=${CONFIG.SESSION_DURATION}`;
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
        const domain = getBranding(c).cookieDomain;
        const cookie = `qti_token=${sessionToken}; Path=/; Domain=${domain}; HttpOnly; Secure; SameSite=None; Max-Age=${CONFIG.SESSION_DURATION}`;
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
        const domain = getBranding(c).cookieDomain;
        const cookie = `qti_token=deleted; Path=/; Domain=${domain}; HttpOnly; Secure; SameSite=None; Max-Age=0`;
        c.header('Set-Cookie', cookie);
    } catch (e) {
        console.error('Failed to clear cookie on logout:', e);
    }

    return c.json({ message: 'Logged out' });
});

// ============================================================================
// REPORTING ROUTES
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
// DATABASE CLEANUP ROUTES
// ============================================================================

// Cleanup expired/stale data - should be called by a scheduled job (e.g., Cloudflare Cron Trigger)
// Can also be triggered manually by admins
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
        // 1. Delete expired sessions (keep revoked sessions for audit, but delete truly expired ones after 30 days)
        const thirtyDaysAgo = currentTime - (30 * 24 * 60 * 60);
        const expiredSessions = await db.prepare(
            'DELETE FROM user_sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)'
        ).bind(thirtyDaysAgo, thirtyDaysAgo).run();
        results.expired_sessions = expiredSessions.meta?.changes || 0;

        // 2. Delete old security events (keep for 90 days for audit)
        const ninetyDaysAgo = currentTime - (90 * 24 * 60 * 60);
        const oldEvents = await db.prepare(
            'DELETE FROM session_security_events WHERE created_at < ?'
        ).bind(ninetyDaysAgo).run();
        results.old_security_events = oldEvents.meta?.changes || 0;

        // 3. Delete expired OAuth states (older than 1 hour)
        const oneHourAgo = currentTime - 3600;
        const expiredOauthStates = await db.prepare(
            'DELETE FROM oauth_states WHERE created_at < ?'
        ).bind(oneHourAgo).run();
        results.expired_oauth_states = expiredOauthStates.meta?.changes || 0;

        // 4. Delete expired OAuth temp data (older than 1 hour)
        const expiredOauthTemp = await db.prepare(
            'DELETE FROM oauth_temp WHERE created_at < ?'
        ).bind(oneHourAgo).run();
        results.expired_oauth_temp = expiredOauthTemp.meta?.changes || 0;

        // 5. Delete old rate limit entries (older than 24 hours)
        const oneDayAgo = currentTime - (24 * 60 * 60);
        const oldRateLimits = await db.prepare(
            'DELETE FROM mail_rate_limits WHERE timestamp < ?'
        ).bind(oneDayAgo).run();
        results.old_rate_limits = oldRateLimits.meta?.changes || 0;

        // 6. Delete expired email tokens (older than 24 hours - they expire after 15 min but keep for debugging)
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

// ============================================================================
// SUPPORT & KNOWLEDGE BASE ROUTES
// ============================================================================

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
    SELECT t.*, u.username_original as user_username, u.email as user_email
    FROM support_tickets t
    LEFT JOIN users u ON t.user_id = u.id
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
    SELECT t.*, u.username_original as user_username, u.email as user_email
    FROM support_tickets t
    LEFT JOIN users u ON t.user_id = u.id
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
        'SELECT id FROM support_tickets WHERE id = ?'
    ).bind(id).all();

    if (tickets.length === 0) {
        return c.json({ error: 'Ticket not found' }, 404);
    }

    const timestamp = now();
    await db.prepare(`
    INSERT INTO ticket_messages (
      id, ticket_id, author_id, content, is_staff_reply, is_internal_note, created_at
    ) VALUES (?, ?, ?, ?, 1, 0, ?)
  `).bind(generateId(), id, staff.user_id, message.trim(), timestamp).run();

    await db.prepare(
        'UPDATE support_tickets SET status = ?, updated_at = ? WHERE id = ?'
    ).bind('in_progress', timestamp, id).run();

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
// ADMIN USER MANAGEMENT ROUTES
// ============================================================================

// Get all users with filtering and pagination
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

    // Get total count
    const countQuery = `SELECT COUNT(*) as count FROM users ${whereClause}`;
    const { results: countResults } = await db.prepare(countQuery).bind(...params).all();
    const total = countResults[0].count;

    // Get users
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

// Get single user details
app.get('/admin/users/:userId', authMiddleware, adminMiddleware, async (c) => {
    const userId = c.req.param('userId');
    const db = c.env.DB;

    // Get user
    const { results: users } = await db.prepare(`
    SELECT * FROM users WHERE id = ?
  `).bind(userId).all();

    if (users.length === 0) {
        return c.json({ error: 'User not found' }, 404);
    }

    const user = users[0];

    // Get moderation history
    const { results: modActions } = await db.prepare(`
    SELECT ma.*, u.username_original as moderator_username
    FROM moderation_actions ma
    LEFT JOIN users u ON ma.moderator_id = u.id
    WHERE ma.user_id = ?
    ORDER BY ma.created_at DESC
    LIMIT 20
  `).bind(userId).all();

    // Get active sessions count
    const { results: sessionCount } = await db.prepare(`
    SELECT COUNT(*) as count FROM user_sessions
    WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
  `).bind(userId, now()).all();

    // Get reports against this user
    const { results: reports } = await db.prepare(`
    SELECT id, report_type, status, priority, created_at
    FROM user_reports
    WHERE reported_user_id = ?
    ORDER BY created_at DESC
    LIMIT 10
  `).bind(userId).all();

    // Get reports made by this user
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

// Ban a user
app.post('/admin/users/:userId/ban', authMiddleware, adminMiddleware, async (c) => {
    const admin = c.get('user');
    const userId = c.req.param('userId');
    const { reason, internal_notes } = await c.req.json();
    const db = c.env.DB;
    const ip = getClientIP(c);

    if (!reason) {
        return c.json({ error: 'Reason is required' }, 400);
    }

    // Check user exists and isn't already banned
    const { results: users } = await db.prepare('SELECT id, is_banned FROM users WHERE id = ?').bind(userId).all();
    if (users.length === 0) {
        return c.json({ error: 'User not found' }, 404);
    }
    if (users[0].is_banned) {
        return c.json({ error: 'User is already banned' }, 400);
    }

    // Ban the user
    await db.prepare(`
    UPDATE users
    SET is_banned = 1, ban_reason = ?, banned_at = ?, banned_by = ?
    WHERE id = ?
  `).bind(reason, now(), admin.user_id, userId).run();

    // Create moderation action
    const actionId = generateId();
    await db.prepare(`
    INSERT INTO moderation_actions (id, user_id, moderator_id, action_type, reason, internal_notes, created_at)
    VALUES (?, ?, ?, 'ban', ?, ?, ?)
  `).bind(actionId, userId, admin.user_id, reason, internal_notes || null, now()).run();

    // Revoke all sessions
    await db.prepare(`
    UPDATE user_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL
  `).bind(now(), userId).run();

    // Log admin action
    await db.prepare(`
    INSERT INTO admin_logs (id, admin_id, action, target_id, target_type, details, ip_address, created_at)
    VALUES (?, ?, 'ban_user', ?, 'user', ?, ?, ?)
  `).bind(generateId(), admin.user_id, userId, JSON.stringify({ reason, internal_notes }), ip, now()).run();

    // Update daily stats
    await db.prepare(`
    INSERT INTO daily_stats (date, accounts_banned, updated_at)
    VALUES (date('now'), 1, ?)
    ON CONFLICT(date) DO UPDATE SET accounts_banned = accounts_banned + 1, updated_at = excluded.updated_at
  `).bind(now()).run();

    return c.json({ message: 'User banned successfully', action_id: actionId });
});

// Unban a user
app.post('/admin/users/:userId/unban', authMiddleware, adminMiddleware, async (c) => {
    const admin = c.get('user');
    const userId = c.req.param('userId');
    const { reason } = await c.req.json();
    const db = c.env.DB;
    const ip = getClientIP(c);

    // Check user exists and is banned
    const { results: users } = await db.prepare('SELECT id, is_banned FROM users WHERE id = ?').bind(userId).all();
    if (users.length === 0) {
        return c.json({ error: 'User not found' }, 404);
    }
    if (!users[0].is_banned) {
        return c.json({ error: 'User is not banned' }, 400);
    }

    // Unban the user
    await db.prepare(`
    UPDATE users SET is_banned = 0, ban_reason = NULL, banned_at = NULL, banned_by = NULL WHERE id = ?
  `).bind(userId).run();

    // Create moderation action
    const actionId = generateId();
    await db.prepare(`
    INSERT INTO moderation_actions (id, user_id, moderator_id, action_type, reason, created_at)
    VALUES (?, ?, ?, 'unban', ?, ?)
  `).bind(actionId, userId, admin.user_id, reason || 'Unbanned by admin', now()).run();

    // Log admin action
    await db.prepare(`
    INSERT INTO admin_logs (id, admin_id, action, target_id, target_type, details, ip_address, created_at)
    VALUES (?, ?, 'unban_user', ?, 'user', ?, ?, ?)
  `).bind(generateId(), admin.user_id, userId, JSON.stringify({ reason }), ip, now()).run();

    return c.json({ message: 'User unbanned successfully', action_id: actionId });
});

// Lock a user account (temporary restriction)
app.post('/admin/users/:userId/lock', authMiddleware, adminMiddleware, async (c) => {
    const admin = c.get('user');
    const userId = c.req.param('userId');
    const { reason, duration, internal_notes } = await c.req.json();
    const db = c.env.DB;
    const ip = getClientIP(c);

    if (!reason) {
        return c.json({ error: 'Reason is required' }, 400);
    }

    // Check user exists
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

    // Calculate expiry (duration in seconds, null for indefinite)
    const expiresAt = duration ? now() + duration : null;

    // Lock the user
    await db.prepare(`
    UPDATE users
    SET is_locked = 1, lock_reason = ?, locked_at = ?, locked_by = ?, lock_expires_at = ?
    WHERE id = ?
  `).bind(reason, now(), admin.user_id, expiresAt, userId).run();

    // Create moderation action
    const actionId = generateId();
    await db.prepare(`
    INSERT INTO moderation_actions (id, user_id, moderator_id, action_type, duration, reason, internal_notes, created_at, expires_at)
    VALUES (?, ?, ?, 'lock', ?, ?, ?, ?, ?)
  `).bind(actionId, userId, admin.user_id, duration || null, reason, internal_notes || null, now(), expiresAt).run();

    // Revoke all sessions
    await db.prepare(`
    UPDATE user_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL
  `).bind(now(), userId).run();

    // Log admin action
    await db.prepare(`
    INSERT INTO admin_logs (id, admin_id, action, target_id, target_type, details, ip_address, created_at)
    VALUES (?, ?, 'lock_user', ?, 'user', ?, ?, ?)
  `).bind(generateId(), admin.user_id, userId, JSON.stringify({ reason, duration, internal_notes }), ip, now()).run();

    return c.json({ message: 'User locked successfully', action_id: actionId, expires_at: expiresAt });
});

// Unlock a user account
app.post('/admin/users/:userId/unlock', authMiddleware, adminMiddleware, async (c) => {
    const admin = c.get('user');
    const userId = c.req.param('userId');
    const { reason } = await c.req.json();
    const db = c.env.DB;
    const ip = getClientIP(c);

    // Check user exists and is locked
    const { results: users } = await db.prepare('SELECT id, is_locked FROM users WHERE id = ?').bind(userId).all();
    if (users.length === 0) {
        return c.json({ error: 'User not found' }, 404);
    }
    if (!users[0].is_locked) {
        return c.json({ error: 'User is not locked' }, 400);
    }

    // Unlock the user
    await db.prepare(`
    UPDATE users SET is_locked = 0, lock_reason = NULL, locked_at = NULL, locked_by = NULL, lock_expires_at = NULL WHERE id = ?
  `).bind(userId).run();

    // Create moderation action
    const actionId = generateId();
    await db.prepare(`
    INSERT INTO moderation_actions (id, user_id, moderator_id, action_type, reason, created_at)
    VALUES (?, ?, ?, 'unlock', ?, ?)
  `).bind(actionId, userId, admin.user_id, reason || 'Unlocked by admin', now()).run();

    // Log admin action
    await db.prepare(`
    INSERT INTO admin_logs (id, admin_id, action, target_id, target_type, details, ip_address, created_at)
    VALUES (?, ?, 'unlock_user', ?, 'user', ?, ?, ?)
  `).bind(generateId(), admin.user_id, userId, JSON.stringify({ reason }), ip, now()).run();

    return c.json({ message: 'User unlocked successfully', action_id: actionId });
});

// Force password/session reset (forces user to re-authenticate)
app.post('/admin/users/:userId/force-reauth', authMiddleware, adminMiddleware, async (c) => {
    const admin = c.get('user');
    const userId = c.req.param('userId');
    const { reason } = await c.req.json();
    const db = c.env.DB;
    const ip = getClientIP(c);

    // Check user exists
    const { results: users } = await db.prepare('SELECT id FROM users WHERE id = ?').bind(userId).all();
    if (users.length === 0) {
        return c.json({ error: 'User not found' }, 404);
    }

    // Revoke all sessions
    const result = await db.prepare(`
    UPDATE user_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL
  `).bind(now(), userId).run();

    // Log admin action
    await db.prepare(`
    INSERT INTO admin_logs (id, admin_id, action, target_id, target_type, details, ip_address, created_at)
    VALUES (?, ?, 'force_reauth', ?, 'user', ?, ?, ?)
  `).bind(generateId(), admin.user_id, userId, JSON.stringify({ reason, sessions_revoked: result.meta?.changes || 0 }), ip, now()).run();

    return c.json({ message: 'User sessions revoked, re-authentication required', sessions_revoked: result.meta?.changes || 0 });
});

// ============================================================================
// ADMIN AUDIT LOG ROUTES
// ============================================================================

// Get audit logs with filtering
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

    // Get total count
    const countQuery = `SELECT COUNT(*) as count FROM admin_logs al ${whereClause}`;
    const { results: countResults } = await db.prepare(countQuery).bind(...params).all();
    const total = countResults[0].count;

    // Get logs with admin username
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

    // Parse JSON details
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

// Get list of unique actions for filtering
app.get('/admin/audit-logs/actions', authMiddleware, adminMiddleware, async (c) => {
    const db = c.env.DB;

    const { results } = await db.prepare('SELECT DISTINCT action FROM admin_logs ORDER BY action').all();

    return c.json({ actions: results.map(r => r.action) });
});

// Get list of admins for filtering
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

// Get moderation actions history (separate from admin logs)
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

    // Get total count
    const countQuery = `SELECT COUNT(*) as count FROM moderation_actions ma ${whereClause}`;
    const { results: countResults } = await db.prepare(countQuery).bind(...params).all();
    const total = countResults[0].count;

    // Get actions
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

// ============================================================================
// OAUTH 2.1 / OPENID CONNECT PROVIDER ENDPOINTS
// ============================================================================

// OpenID Connect Discovery Document
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
        service_documentation: getBranding(c).serviceDocumentationUrl,
    });
});

// JWKS endpoint - returns public key for ID token verification
app.get('/.well-known/jwks.json', async (c) => {
    const publicKeyPem = c.env.OAUTH_PROVIDER_PUBLIC_KEY;

    if (!publicKeyPem) {
        return c.json({ keys: [] });
    }

    try {
        // Import the public key to get its components
        const publicKey = await importPublicKey(publicKeyPem);
        const jwk = await crypto.subtle.exportKey('jwk', publicKey);

        return c.json({
            keys: [{
                kty: jwk.kty,
                use: 'sig',
                alg: 'RS256',
                kid: 'qti-auth-1', // Key ID - increment when rotating keys
                n: jwk.n,
                e: jwk.e,
            }]
        });
    } catch (e) {
        console.error('JWKS error:', e);
        return c.json({ keys: [] });
    }
});

// ============================================================================
// OAUTH CLIENT MANAGEMENT (Developer Portal)
// ============================================================================

// Register new OAuth client (any authenticated user)
app.post('/oauth/clients', authMiddleware, async (c) => {
    const user = c.get('user');
    const db = c.env.DB;

    // Children cannot create OAuth clients
    if (user.is_child) {
        return c.json({ error: 'Child accounts cannot create OAuth applications' }, 403);
    }

    const { name, description, homepage_url, privacy_policy_url, redirect_uris, client_type = 'confidential' } = await c.req.json();

    // Validation
    if (!name || name.length < 3 || name.length > 100) {
        return c.json({ error: 'Name must be between 3 and 100 characters' }, 400);
    }

    if (!redirect_uris || !Array.isArray(redirect_uris) || redirect_uris.length === 0) {
        return c.json({ error: 'At least one redirect URI is required' }, 400);
    }

    // Validate redirect URIs
    for (const uri of redirect_uris) {
        try {
            const url = new URL(uri);
            // OAuth 2.1 requires HTTPS except for localhost
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

    const clientId = generateId();
    const clientSecret = generateSecureToken(32);
    const clientSecretHash = await hashToken(clientSecret);
    const currentTime = now();

    await db.prepare(`
    INSERT INTO oauth_clients (id, client_secret_hash, name, description, homepage_url, privacy_policy_url, redirect_uris, client_type, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
        clientId,
        clientSecretHash,
        name,
        description || null,
        homepage_url || null,
        privacy_policy_url || null,
        JSON.stringify(redirect_uris),
        client_type,
        user.user_id,
        currentTime,
        currentTime
    ).run();

    return c.json({
        client_id: clientId,
        client_secret: clientSecret, // Only shown once!
        name,
        redirect_uris,
        client_type,
        is_approved: false,
        message: 'Save your client secret securely - it will not be shown again. Your app can only be used by you until an admin approves it.',
    }, 201);
});

// List my OAuth clients
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

// Get specific OAuth client (owner only)
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

// Update OAuth client (owner only)
app.put('/oauth/clients/:id', authMiddleware, async (c) => {
    const user = c.get('user');
    const db = c.env.DB;
    const clientId = c.req.param('id');

    // Check ownership
    const { results: existing } = await db.prepare(
        'SELECT id FROM oauth_clients WHERE id = ? AND created_by = ?'
    ).bind(clientId, user.user_id).all();

    if (existing.length === 0) {
        return c.json({ error: 'Client not found' }, 404);
    }

    const { name, description, homepage_url, privacy_policy_url, redirect_uris } = await c.req.json();

    const updates = [];
    const params = [];

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

// Delete OAuth client (owner only)
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

// Regenerate client secret (owner only)
app.post('/oauth/clients/:id/regenerate-secret', authMiddleware, async (c) => {
    const user = c.get('user');
    const db = c.env.DB;
    const clientId = c.req.param('id');

    // Check ownership
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

    // Revoke all existing tokens for this client
    await db.prepare('UPDATE oauth_access_tokens SET revoked = 1 WHERE client_id = ?').bind(clientId).run();
    await db.prepare('UPDATE oauth_refresh_tokens SET revoked = 1 WHERE client_id = ?').bind(clientId).run();

    return c.json({
        client_secret: newSecret,
        message: 'Save your new client secret securely - it will not be shown again. All existing tokens have been revoked.',
    });
});

// Request approval for OAuth client (owner only)
app.post('/oauth/clients/:id/request-approval', authMiddleware, async (c) => {
    const user = c.get('user');
    const db = c.env.DB;
    const clientId = c.req.param('id');

    // Check ownership and current status
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

// ============================================================================
// OAUTH AUTHORIZATION ENDPOINT
// ============================================================================

// Authorization endpoint (GET for user redirect, shows consent screen)
app.get('/oauth/authorize', authMiddleware, async (c) => {
    const user = c.get('user');
    const db = c.env.DB;

    // Children cannot authorize third-party apps
    if (user.is_child) {
        const errorUrl = new URL(getBranding(c).frontendUrl + '/oauth-error');
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

    // Validate required parameters
    if (!client_id) {
        return c.json({ error: 'invalid_request', error_description: 'client_id is required' }, 400);
    }

    if (!redirect_uri) {
        return c.json({ error: 'invalid_request', error_description: 'redirect_uri is required' }, 400);
    }

    if (response_type !== 'code') {
        return c.json({ error: 'unsupported_response_type', error_description: 'Only response_type=code is supported (OAuth 2.1)' }, 400);
    }

    // PKCE is mandatory in OAuth 2.1
    if (!code_challenge) {
        return c.json({ error: 'invalid_request', error_description: 'code_challenge is required (PKCE mandatory in OAuth 2.1)' }, 400);
    }

    if (code_challenge_method !== 'S256') {
        return c.json({ error: 'invalid_request', error_description: 'code_challenge_method must be S256 (plain not allowed in OAuth 2.1)' }, 400);
    }

    // Validate client exists and is active
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

    // Non-approved clients can only be used by their owner
    if (!client.is_approved && client.created_by !== user.user_id) {
        return c.json({ error: 'invalid_client', error_description: 'Client is not approved for public use' }, 400);
    }

    // Validate redirect_uri (exact match per OAuth 2.1)
    if (!validateRedirectUri(redirect_uri, client.redirect_uris)) {
        return c.json({ error: 'invalid_request', error_description: 'redirect_uri does not match any registered URIs' }, 400);
    }

    // Validate scopes
    if (!validateScopes(scope, client.allowed_scopes)) {
        const errorUrl = new URL(redirect_uri);
        errorUrl.searchParams.set('error', 'invalid_scope');
        errorUrl.searchParams.set('error_description', 'Requested scope is not allowed for this client');
        if (state) errorUrl.searchParams.set('state', state);
        return c.redirect(errorUrl.toString());
    }

    // openid scope is required for OIDC
    const scopes = scope.split(' ').filter(s => s);
    if (!scopes.includes('openid')) {
        const errorUrl = new URL(redirect_uri);
        errorUrl.searchParams.set('error', 'invalid_scope');
        errorUrl.searchParams.set('error_description', 'openid scope is required');
        if (state) errorUrl.searchParams.set('state', state);
        return c.redirect(errorUrl.toString());
    }

    // Check if user has already consented to this client with these scopes
    const { results: existingConsents } = await db.prepare(`
    SELECT scope FROM oauth_consents WHERE user_id = ? AND client_id = ?
  `).bind(user.user_id, client_id).all();

    const needsConsent = existingConsents.length === 0 ||
        !scopes.every(s => JSON.parse(existingConsents[0].scope).includes(s));

    if (!needsConsent) {
        // User already consented - issue authorization code directly
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

    // Redirect to frontend consent screen
    const consentUrl = new URL(getBranding(c).frontendUrl + '/oauth/authorize');
    consentUrl.searchParams.set('client_id', client_id);
    consentUrl.searchParams.set('redirect_uri', redirect_uri);
    consentUrl.searchParams.set('scope', scope);
    consentUrl.searchParams.set('state', state || '');
    consentUrl.searchParams.set('code_challenge', code_challenge);
    consentUrl.searchParams.set('code_challenge_method', code_challenge_method);
    if (nonce) consentUrl.searchParams.set('nonce', nonce);

    return c.redirect(consentUrl.toString());
});

// Get client info for consent screen (authenticated)
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

    // Build scope descriptions
    const scopeDescriptions = {
        openid: 'Verify your identity',
        profile: 'Access your username and profile information',
        email: 'Access your email address',
    };

    return c.json({
        client,
        scopes: scopes.map(s => ({ name: s, description: scopeDescriptions[s] || s })),
    });
});

// Submit consent decision (POST from consent screen)
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
        consent, // 'allow' or 'deny'
    } = await c.req.json();

    // If user denied, redirect with error
    if (consent !== 'allow') {
        const errorUrl = new URL(redirect_uri);
        errorUrl.searchParams.set('error', 'access_denied');
        errorUrl.searchParams.set('error_description', 'User denied the authorization request');
        if (state) errorUrl.searchParams.set('state', state);
        return c.json({ redirect: errorUrl.toString() });
    }

    // Validate client again
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

    // Save consent
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

    // Generate authorization code
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

// ============================================================================
// OAUTH TOKEN ENDPOINT
// ============================================================================

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

    // Get client credentials from Basic auth or body
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

    // Validate client
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

    // Confidential clients must authenticate
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

    // Look up authorization code
    const { results: codes } = await db.prepare(`
    SELECT * FROM oauth_authorization_codes
    WHERE code_hash = ? AND client_id = ? AND used = 0 AND expires_at > ?
  `).bind(codeHash, client.id, currentTime).all();

    if (codes.length === 0) {
        return c.json({ error: 'invalid_grant', error_description: 'Invalid or expired authorization code' }, 400);
    }

    const authCode = codes[0];

    // Verify redirect_uri matches
    if (redirectUri && redirectUri !== authCode.redirect_uri) {
        return c.json({ error: 'invalid_grant', error_description: 'redirect_uri does not match' }, 400);
    }

    // Verify PKCE
    const pkceValid = await verifyPKCE(codeVerifier, authCode.code_challenge);
    if (!pkceValid) {
        return c.json({ error: 'invalid_grant', error_description: 'Invalid code_verifier' }, 400);
    }

    // Mark code as used (single-use)
    await db.prepare('UPDATE oauth_authorization_codes SET used = 1 WHERE code_hash = ?').bind(codeHash).run();

    // Get user info
    const { results: users } = await db.prepare(`
    SELECT id, username_original, email, updated_at
    FROM users WHERE id = ?
  `).bind(authCode.user_id).all();

    if (users.length === 0) {
        return c.json({ error: 'invalid_grant', error_description: 'User not found' }, 400);
    }

    const user = users[0];
    const scopes = authCode.scope.split(' ').filter(s => s);

    // Generate tokens
    const accessToken = generateSecureToken(32);
    const refreshToken = generateSecureToken(32);
    const accessTokenHash = await hashToken(accessToken);
    const refreshTokenHash = await hashToken(refreshToken);

    const accessTokenExpiry = currentTime + CONFIG.OAUTH_PROVIDER.ACCESS_TOKEN_EXPIRY;
    const refreshTokenExpiry = currentTime + CONFIG.OAUTH_PROVIDER.REFRESH_TOKEN_EXPIRY;

    // Store tokens
    await db.prepare(`
    INSERT INTO oauth_access_tokens (token_hash, client_id, user_id, scope, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(accessTokenHash, client.id, user.id, authCode.scope, currentTime, accessTokenExpiry).run();

    await db.prepare(`
    INSERT INTO oauth_refresh_tokens (token_hash, client_id, user_id, scope, access_token_hash, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(refreshTokenHash, client.id, user.id, authCode.scope, accessTokenHash, currentTime, refreshTokenExpiry).run();

    // Build ID token
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

    // Add at_hash
    idTokenPayload.at_hash = await generateAtHash(accessToken);

    // Add claims based on scopes
    const userClaims = buildUserClaims(user, scopes);
    Object.assign(idTokenPayload, userClaims);

    // Sign ID token with RS256
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

    // Look up refresh token
    const { results: tokens } = await db.prepare(`
    SELECT * FROM oauth_refresh_tokens
    WHERE token_hash = ? AND client_id = ? AND revoked = 0 AND expires_at > ?
  `).bind(tokenHash, client.id, currentTime).all();

    if (tokens.length === 0) {
        return c.json({ error: 'invalid_grant', error_description: 'Invalid or expired refresh token' }, 400);
    }

    const oldRefreshToken = tokens[0];

    // Get user info
    const { results: users } = await db.prepare(`
    SELECT id, username_original, email, updated_at, is_banned
    FROM users WHERE id = ?
  `).bind(oldRefreshToken.user_id).all();

    if (users.length === 0 || users[0].is_banned) {
        return c.json({ error: 'invalid_grant', error_description: 'User not found or banned' }, 400);
    }

    const user = users[0];

    // Rotate tokens (OAuth 2.1 requirement)
    // Revoke old refresh token and its associated access token
    await db.prepare('UPDATE oauth_refresh_tokens SET revoked = 1 WHERE token_hash = ?').bind(tokenHash).run();
    if (oldRefreshToken.access_token_hash) {
        await db.prepare('UPDATE oauth_access_tokens SET revoked = 1 WHERE token_hash = ?').bind(oldRefreshToken.access_token_hash).run();
    }

    // Generate new tokens
    const newAccessToken = generateSecureToken(32);
    const newRefreshToken = generateSecureToken(32);
    const newAccessTokenHash = await hashToken(newAccessToken);
    const newRefreshTokenHash = await hashToken(newRefreshToken);

    const accessTokenExpiry = currentTime + CONFIG.OAUTH_PROVIDER.ACCESS_TOKEN_EXPIRY;
    const refreshTokenExpiry = currentTime + CONFIG.OAUTH_PROVIDER.REFRESH_TOKEN_EXPIRY;

    // Store new tokens
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

// ============================================================================
// OAUTH USERINFO ENDPOINT
// ============================================================================

app.get('/oauth/userinfo', async (c) => {
    const db = c.env.DB;

    // Get access token from Authorization header
    const authHeader = c.req.header('authorization');
    if (!authHeader?.startsWith('Bearer ')) {
        return c.json({ error: 'invalid_token', error_description: 'Bearer token required' }, 401);
    }

    const accessToken = authHeader.slice(7);
    const tokenHash = await hashToken(accessToken);
    const currentTime = now();

    // Validate access token
    const { results: tokens } = await db.prepare(`
    SELECT user_id, scope FROM oauth_access_tokens
    WHERE token_hash = ? AND revoked = 0 AND expires_at > ?
  `).bind(tokenHash, currentTime).all();

    if (tokens.length === 0) {
        return c.json({ error: 'invalid_token', error_description: 'Invalid or expired access token' }, 401);
    }

    const token = tokens[0];

    // Get user info
    const { results: users } = await db.prepare(`
    SELECT id, username_original, email, updated_at
    FROM users WHERE id = ?
  `).bind(token.user_id).all();

    if (users.length === 0) {
        return c.json({ error: 'invalid_token', error_description: 'User not found' }, 401);
    }

    const user = users[0];
    const scopes = token.scope.split(' ').filter(s => s);

    // Build response based on scopes
    const response = buildUserClaims(user, scopes);

    return c.json(response);
});

// POST also supported for userinfo
app.post('/oauth/userinfo', async (c) => {
    // Delegate to GET handler - same logic
    return app.fetch(new Request(c.req.url, { method: 'GET', headers: c.req.raw.headers }), c.env, c.executionCtx);
});

// ============================================================================
// OAUTH TOKEN REVOCATION & INTROSPECTION
// ============================================================================

// Token revocation (RFC 7009)
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

    // Get client credentials
    let authClientId = client_id;
    let authClientSecret = client_secret;

    const authHeader = c.req.header('authorization');
    if (authHeader?.startsWith('Basic ')) {
        const decoded = atob(authHeader.slice(6));
        const [id, secret] = decoded.split(':');
        authClientId = authClientId || decodeURIComponent(id);
        authClientSecret = authClientSecret || decodeURIComponent(secret);
    }

    // Validate client if provided
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

    // Try to revoke as access token first, then refresh token
    if (token_type_hint !== 'refresh_token') {
        await db.prepare('UPDATE oauth_access_tokens SET revoked = 1 WHERE token_hash = ?').bind(tokenHash).run();
    }

    if (token_type_hint !== 'access_token') {
        await db.prepare('UPDATE oauth_refresh_tokens SET revoked = 1 WHERE token_hash = ?').bind(tokenHash).run();
    }

    // Always return 200 OK per RFC 7009
    return c.json({});
});

// Token introspection (RFC 7662)
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

    // Get client credentials
    let authClientId = client_id;
    let authClientSecret = client_secret;

    const authHeader = c.req.header('authorization');
    if (authHeader?.startsWith('Basic ')) {
        const decoded = atob(authHeader.slice(6));
        const [id, secret] = decoded.split(':');
        authClientId = authClientId || decodeURIComponent(id);
        authClientSecret = authClientSecret || decodeURIComponent(secret);
    }

    // Client authentication required for introspection
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

    // Try access token first
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

    // Try refresh token
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

    // Token not found - return inactive
    return c.json({ active: false });
});

// ============================================================================
// USER AUTHORIZED APPS MANAGEMENT
// ============================================================================

// List apps the user has authorized
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

// Revoke authorization for an app
app.delete('/oauth/authorized-apps/:client_id', authMiddleware, async (c) => {
    const user = c.get('user');
    const db = c.env.DB;
    const clientId = c.req.param('client_id');

    // Delete consent
    await db.prepare('DELETE FROM oauth_consents WHERE user_id = ? AND client_id = ?')
        .bind(user.user_id, clientId).run();

    // Revoke all tokens for this user+client
    await db.prepare('UPDATE oauth_access_tokens SET revoked = 1 WHERE user_id = ? AND client_id = ?')
        .bind(user.user_id, clientId).run();
    await db.prepare('UPDATE oauth_refresh_tokens SET revoked = 1 WHERE user_id = ? AND client_id = ?')
        .bind(user.user_id, clientId).run();

    return c.json({ success: true });
});

// ============================================================================
// ADMIN OAUTH CLIENT MANAGEMENT
// ============================================================================

// List all OAuth clients (admin)
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

// Approve OAuth client (admin)
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

    // Log admin action
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

// Revoke OAuth client approval (admin)
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

    // Log admin action
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

// ============================================================================
// HEALTH CHECK
// ============================================================================

app.get('/health', (c) => {
    return c.json({ status: 'ok', timestamp: now() });
});

// ============================================================================
// EXPORT
// ============================================================================

export default {
    fetch: app.fetch,
    scheduled: handleScheduled,
};

