import { sections } from '@qtiauth/config';
import { describe, expect, it } from 'vitest';

import {
  bindStartUrl,
  isSameSite,
  isTopLevelNavigation,
  listenPorts,
  matchSurface,
  needsSessionBinding,
  requestHost,
  resolveSurfaces,
  surfacePairs,
} from './surfaces.ts';

const oneHost = resolveSurfaces({
  surfaces: sections.surfaces.parse({
    account: { hosts: ['me.example.com'], base_path: '/' },
    support: { hosts: ['me.example.com'], base_path: '/support' },
    api: { hosts: ['me.example.com'], base_path: '/api' },
  }),
});

const byPort = resolveSurfaces({
  surfaces: sections.surfaces.parse({
    account: { ports: [8080] },
    support: { ports: [8081] },
    api: { ports: [8082], origins: ['http://10.0.0.5:8082'] },
  }),
});

const splitHosts = resolveSurfaces({
  surfaces: sections.surfaces.parse({
    account: { hosts: ['account.example.co.uk'] },
    support: { hosts: ['support.example.com'] },
    api: { hosts: ['auth.example.co.uk'] },
  }),
});

describe('resolveSurfaces', () => {
  it('uses the default modules and derives https origins from hosts', () => {
    const [account, support, api] = oneHost;
    expect(account?.origins).toEqual(['https://me.example.com']);
    expect([...(account?.modules ?? [])]).toEqual(['identity', 'oidc', 'games', 'safety', 'admin']);
    expect([...(support?.modules ?? [])]).toEqual(['support']);
    expect(api?.modules.size).toBe(6);
    expect(byPort[0]?.origins).toEqual([]);
    expect(byPort[2]?.origins).toEqual(['http://10.0.0.5:8082']);
  });
});

describe('matchSurface', () => {
  it('picks the longest base path on a shared host', () => {
    const match = (path: string) => {
      const found = matchSurface(oneHost, 'me.example.com', 8000, path);
      return found && [found.surface.name, found.path];
    };
    expect(match('/api/v1/me')).toEqual(['api', '/v1/me']);
    expect(match('/support')).toEqual(['support', '/']);
    expect(match('/support/api/v1/me')).toEqual(['support', '/api/v1/me']);
    expect(match('/supporters')).toEqual(['account', '/supporters']);
    expect(match('/')).toEqual(['account', '/']);
    expect(matchSurface(oneHost, 'other.example.com', 8000, '/')).toBeNull();
  });

  it('matches port-based surfaces by the port the request arrived on', () => {
    expect(matchSurface(byPort, null, 8081, '/api/v1/me')?.surface.name).toBe('support');
    expect(matchSurface(byPort, 'anything', 8082, '/')?.surface.name).toBe('api');
    expect(matchSurface(byPort, null, 9000, '/')).toBeNull();
  });
});

describe('requestHost', () => {
  it('drops the port and lowercases', () => {
    expect(requestHost('Me.Example.com:8443')).toBe('me.example.com');
    expect(requestHost('me.example.com.')).toBe('me.example.com');
    expect(requestHost('[::1]:8000')).toBe('[::1]');
    expect(requestHost(null)).toBeNull();
  });
});

describe('listenPorts', () => {
  it('listens on the host port and every surface port', () => {
    expect(listenPorts(oneHost, 8000)).toEqual([8000]);
    expect(listenPorts(byPort, 8000)).toEqual([8080, 8081, 8082]);
  });
});

describe('same-site pairs', () => {
  it('compares registrable domains and schemes', () => {
    expect(isSameSite('https://account.example.com', 'https://support.example.com')).toBe(true);
    expect(isSameSite('https://account.example.co.uk', 'https://auth.example.co.uk')).toBe(true);
    expect(isSameSite('https://a.co.uk', 'https://b.co.uk')).toBe(false);
    expect(isSameSite('https://example.co.uk', 'https://example.com')).toBe(false);
    expect(isSameSite('http://example.com', 'https://example.com')).toBe(false);
    expect(isSameSite('http://localhost:8000', 'http://localhost:8001')).toBe(true);
  });

  it('reports every surface pair', () => {
    expect(surfacePairs(splitHosts)).toEqual([
      { surfaces: ['account', 'support'], same_site: false },
      { surfaces: ['account', 'api'], same_site: true },
      { surfaces: ['support', 'api'], same_site: false },
    ]);
    expect(surfacePairs(byPort)[0]?.same_site).toBe(false);
  });
});

describe('session binding', () => {
  it('is needed only when the cookie would not be sent to the account host', () => {
    const [account] = splitHosts;
    expect(account).toBeDefined();
    if (account === undefined) return;
    expect(needsSessionBinding({ domain: null }, 'support.example.com', account)).toBe(true);
    expect(needsSessionBinding({ domain: null }, 'account.example.co.uk', account)).toBe(false);
    expect(needsSessionBinding({ domain: 'example.com' }, 'support.example.com', account)).toBe(
      false,
    );
    expect(needsSessionBinding({ domain: 'example.com' }, 'support.example.org', account)).toBe(
      true,
    );
    expect(needsSessionBinding({ domain: null }, 'anything', byPort[0] ?? account)).toBe(false);
  });

  it('builds the account bind URL and recognises top-level navigations', () => {
    const [account] = splitHosts;
    expect(account).toBeDefined();
    if (account === undefined) return;
    expect(bindStartUrl(account, 'support', '/inbox')).toBe(
      'https://account.example.co.uk/auth/bind?target=support&return=%2Finbox',
    );
    expect(
      isTopLevelNavigation(
        new Request('https://support.example.com/inbox', { headers: { accept: 'text/html' } }),
      ),
    ).toBe(true);
    expect(
      isTopLevelNavigation(
        new Request('https://support.example.com/api/v1/me', {
          headers: { accept: 'application/json' },
        }),
      ),
    ).toBe(false);
    expect(
      isTopLevelNavigation(
        new Request('https://support.example.com/inbox', {
          headers: { 'sec-fetch-mode': 'cors', accept: 'text/html' },
        }),
      ),
    ).toBe(false);
    expect(
      isTopLevelNavigation(
        new Request('https://support.example.com/inbox', {
          headers: { 'sec-fetch-mode': 'navigate' },
        }),
      ),
    ).toBe(true);
  });
});
