import { getAccessToken, refreshAccessToken, logout } from './auth';

const API_BASE = (import.meta.env.VITE_API_URL || '/api').replace(/\/+$/, '');

function buildUrl(path) {
  if (!path) return API_BASE;
  return `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`;
}

async function handleResponse(response) {
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const error = data?.error || 'Request failed';
    const err = new Error(error);
    err.status = response.status;
    throw err;
  }
  return data;
}

function getAuthHeaders() {
  const token = getAccessToken();
  if (!token) return {};
  return { 'Authorization': `Bearer ${token}` };
}

// Wrapper to handle token refresh on 401
async function fetchWithRefresh(url, options, retried = false) {
  const response = await fetch(url, options);

  if (response.status === 401 && !retried) {
    // Try to refresh the token
    try {
      await refreshAccessToken();
      // Retry with new token
      const newOptions = {
        ...options,
        headers: {
          ...options.headers,
          ...getAuthHeaders(),
        },
      };
      return fetch(url, newOptions);
    } catch (refreshError) {
      // Refresh failed, user needs to log in again
      logout();
      throw new Error('Session expired. Please log in again.');
    }
  }

  return response;
}

export async function apiGet(path) {
  const response = await fetchWithRefresh(buildUrl(path), {
    headers: {
      ...getAuthHeaders(),
    },
  });
  return handleResponse(response);
}

export async function apiPost(path, body) {
  const response = await fetchWithRefresh(buildUrl(path), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...getAuthHeaders(),
    },
    body: JSON.stringify(body || {}),
  });
  return handleResponse(response);
}

export async function apiPut(path, body) {
  const response = await fetchWithRefresh(buildUrl(path), {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      ...getAuthHeaders(),
    },
    body: JSON.stringify(body || {}),
  });
  return handleResponse(response);
}

export async function apiDelete(path) {
  const response = await fetchWithRefresh(buildUrl(path), {
    method: 'DELETE',
    headers: {
      ...getAuthHeaders(),
    },
  });
  return handleResponse(response);
}
