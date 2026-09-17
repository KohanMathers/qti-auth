import { sections } from '@qtiauth/config';
import { describe, expect, it } from 'vitest';

import {
  allowedOrigins,
  applyCors,
  isPreflight,
  isStateChanging,
  preflightResponse,
} from './cors.ts';
import { resolveSurfaces } from './surfaces.ts';

const surfaces = resolveSurfaces({
  surfaces: sections.surfaces.parse({
    account: { hosts: ['account.example.com'] },
    support: { hosts: ['support.example.com'] },
    api: { hosts: ['api.example.com'] },
  }),
});
const allowed = allowedOrigins(
  { cors: sections.cors.parse({ allowed_origins: ['https://partner.example.org'] }) },
  surfaces,
);

describe('allowedOrigins', () => {
  it('adds every surface origin to the configured origins', () => {
    expect([...allowed]).toEqual([
      'https://account.example.com',
      'https://support.example.com',
      'https://api.example.com',
      'https://partner.example.org',
    ]);
  });
});

describe('applyCors', () => {
  it('allows credentials for allowed origins only', () => {
    const headers = new Headers();
    applyCors(headers, 'https://support.example.com', allowed);
    expect(headers.get('access-control-allow-origin')).toBe('https://support.example.com');
    expect(headers.get('access-control-allow-credentials')).toBe('true');
    expect(headers.get('vary')).toBe('Origin');

    const denied = new Headers();
    applyCors(denied, 'https://evil.example.net', allowed);
    expect(denied.has('access-control-allow-origin')).toBe(false);
    expect(denied.get('vary')).toBe('Origin');
  });
});

describe('preflight', () => {
  const preflight = (origin: string) =>
    new Request('https://api.example.com/v1/me', {
      method: 'OPTIONS',
      headers: { origin, 'access-control-request-method': 'POST' },
    });

  it('recognises preflight requests', () => {
    expect(isPreflight(preflight('https://account.example.com'))).toBe(true);
    expect(isPreflight(new Request('https://api.example.com/', { method: 'OPTIONS' }))).toBe(false);
  });

  it('answers allowed origins with the allowed methods and headers', () => {
    const response = preflightResponse(preflight('https://account.example.com'), allowed);
    expect(response.status).toBe(204);
    expect(Object.fromEntries(response.headers)).toMatchObject({
      'access-control-allow-origin': 'https://account.example.com',
      'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE',
      'access-control-allow-headers': 'Content-Type, Authorization, X-Request-Id',
      'access-control-max-age': '600',
    });
    const denied = preflightResponse(preflight('https://evil.example.net'), allowed);
    expect(denied.headers.has('access-control-allow-origin')).toBe(false);
  });
});

describe('isStateChanging', () => {
  it('treats everything but GET, HEAD and OPTIONS as state-changing', () => {
    expect(['GET', 'HEAD', 'OPTIONS', 'POST', 'DELETE'].map(isStateChanging)).toEqual([
      false,
      false,
      false,
      true,
      true,
    ]);
  });
});
