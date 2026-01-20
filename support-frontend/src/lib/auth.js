// OAuth 2.1 with PKCE authentication for QTI Support

const AUTH_BASE = (import.meta.env.VITE_API_URL || 'https://auth.quietterminal.co.uk').replace(/\/+$/, '');

// OAuth client credentials - these should be set up in the QTI auth system
// The client_id is public, client_secret is only used server-side (we use PKCE instead)
const CLIENT_ID = import.meta.env.VITE_OAUTH_CLIENT_ID || 'qti-support';
const REDIRECT_URI = import.meta.env.VITE_OAUTH_REDIRECT_URI || `${window.location.origin}/oauth/callback`;
const SCOPES = 'openid profile email';

// Generate cryptographically secure random string
function generateRandomString(length) {
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('').slice(0, length);
}

// Generate PKCE code verifier (43-128 chars)
function generateCodeVerifier() {
  return generateRandomString(64);
}

// Generate PKCE code challenge from verifier (S256)
async function generateCodeChallenge(verifier) {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hash = await crypto.subtle.digest('SHA-256', data);
  // Base64url encode
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// Start the OAuth login flow
export async function startLogin() {
  const state = generateRandomString(32);
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);

  // Store state and verifier for validation on callback
  sessionStorage.setItem('oauth_state', state);
  sessionStorage.setItem('oauth_code_verifier', codeVerifier);
  sessionStorage.setItem('oauth_redirect_path', window.location.pathname);

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    state: state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  window.location.href = `${AUTH_BASE}/oauth/authorize?${params.toString()}`;
}

// Handle the OAuth callback - exchange code for tokens
export async function handleCallback(code, state) {
  // Validate state
  const savedState = sessionStorage.getItem('oauth_state');
  if (!savedState || savedState !== state) {
    throw new Error('Invalid state parameter - possible CSRF attack');
  }

  const codeVerifier = sessionStorage.getItem('oauth_code_verifier');
  if (!codeVerifier) {
    throw new Error('Missing code verifier - OAuth flow was not started properly');
  }

  // Exchange code for tokens
  const response = await fetch(`${AUTH_BASE}/oauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: codeVerifier,
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Token exchange failed' }));
    throw new Error(error.error_description || error.error || 'Token exchange failed');
  }

  const tokens = await response.json();

  // Store tokens
  localStorage.setItem('qti_token', tokens.access_token);
  if (tokens.refresh_token) {
    localStorage.setItem('qti_refresh_token', tokens.refresh_token);
  }

  // Clean up OAuth state
  const redirectPath = sessionStorage.getItem('oauth_redirect_path') || '/';
  sessionStorage.removeItem('oauth_state');
  sessionStorage.removeItem('oauth_code_verifier');
  sessionStorage.removeItem('oauth_redirect_path');

  return { tokens, redirectPath };
}

// Refresh the access token using refresh token
export async function refreshAccessToken() {
  const refreshToken = localStorage.getItem('qti_refresh_token');
  if (!refreshToken) {
    throw new Error('No refresh token available');
  }

  const response = await fetch(`${AUTH_BASE}/oauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
  });

  if (!response.ok) {
    // Refresh failed, clear tokens
    localStorage.removeItem('qti_token');
    localStorage.removeItem('qti_refresh_token');
    throw new Error('Token refresh failed');
  }

  const tokens = await response.json();
  localStorage.setItem('qti_token', tokens.access_token);
  if (tokens.refresh_token) {
    localStorage.setItem('qti_refresh_token', tokens.refresh_token);
  }

  return tokens;
}

// Log out - clear tokens
export function logout() {
  localStorage.removeItem('qti_token');
  localStorage.removeItem('qti_refresh_token');
}

// Get current access token
export function getAccessToken() {
  return localStorage.getItem('qti_token');
}

// Check if user is logged in (has token)
export function isLoggedIn() {
  return !!localStorage.getItem('qti_token');
}
