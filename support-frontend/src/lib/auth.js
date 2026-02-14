
import { SUPPORT_BRANDING } from '../config/branding';

const AUTH_BASE = SUPPORT_BRANDING.authBaseUrl.replace(/\/+$/, '');

const CLIENT_ID = import.meta.env.VITE_OAUTH_CLIENT_ID || 'qti-support';
const CLIENT_SECRET = import.meta.env.VITE_OAUTH_CLIENT_SECRET || '';
const REDIRECT_URI = import.meta.env.VITE_OAUTH_REDIRECT_URI || `${window.location.origin}/oauth/callback`;
const SCOPES = 'openid profile email';

function generateRandomString(length) {
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('').slice(0, length);
}

function generateCodeVerifier() {
  return generateRandomString(64);
}

async function generateCodeChallenge(verifier) {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export async function startLogin() {
  const state = generateRandomString(32);
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);

  // Persist PKCE bits across the redirect so we can finish the flow safely.
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

export async function handleCallback(code, state) {
  const savedState = sessionStorage.getItem('oauth_state');
  // If the state doesn't match, slam the brakes.
  if (!savedState || savedState !== state) {
    throw new Error('Invalid state parameter - possible CSRF attack');
  }

  const codeVerifier = sessionStorage.getItem('oauth_code_verifier');
  if (!codeVerifier) {
    throw new Error('Missing code verifier - OAuth flow was not started properly');
  }

  const tokenParams = {
    grant_type: 'authorization_code',
    code: code,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    code_verifier: codeVerifier,
  };

  if (CLIENT_SECRET) {
    tokenParams.client_secret = CLIENT_SECRET;
  }

  const response = await fetch(`${AUTH_BASE}/oauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(tokenParams),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Token exchange failed' }));
    throw new Error(error.error_description || error.error || 'Token exchange failed');
  }

  const tokens = await response.json();

  // Access token for API calls; refresh token stays quiet until needed.
  localStorage.setItem('qti_token', tokens.access_token);
  if (tokens.refresh_token) {
    localStorage.setItem('qti_refresh_token', tokens.refresh_token);
  }

  const redirectPath = sessionStorage.getItem('oauth_redirect_path') || '/';
  sessionStorage.removeItem('oauth_state');
  sessionStorage.removeItem('oauth_code_verifier');
  sessionStorage.removeItem('oauth_redirect_path');

  return { tokens, redirectPath };
}

export async function refreshAccessToken() {
  const refreshToken = localStorage.getItem('qti_refresh_token');
  if (!refreshToken) {
    throw new Error('No refresh token available');
  }

  const refreshParams = {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
  };

  if (CLIENT_SECRET) {
    refreshParams.client_secret = CLIENT_SECRET;
  }

  const response = await fetch(`${AUTH_BASE}/oauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(refreshParams),
  });

  if (!response.ok) {
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

export function logout() {
  localStorage.removeItem('qti_token');
  localStorage.removeItem('qti_refresh_token');
}

export function getAccessToken() {
  return localStorage.getItem('qti_token');
}

export function isLoggedIn() {
  return !!localStorage.getItem('qti_token');
}
