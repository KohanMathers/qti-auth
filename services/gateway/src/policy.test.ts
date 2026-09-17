import { definePermissions, type ManifestRoute } from '@qtiauth/service-kit';
import { describe, expect, it } from 'vitest';

import { checkPolicy, identityFor, impliedGatewayErrors } from './policy.ts';
import type { TableRoute } from './routes.ts';
import type { ResolvedSession } from './sessions.ts';

const NOW = Date.parse('2026-09-17T12:00:00Z');
const permissions = definePermissions({
  'users.read': { description: 'Read users' },
  'safety.csea.access': { description: 'CSEA cases', wildcard: false },
});

function table(overrides: Partial<ManifestRoute> = {}): TableRoute {
  return {
    service: 'identity',
    permissions: new Map(Object.entries(permissions)),
    route: {
      method: 'GET',
      path: '/api/v1/me',
      module: 'core',
      auth: 'session',
      permissions: [],
      scopes: [],
      allow_account_states: ['active'],
      allow_pending_legal: false,
      allow_pending_parental_consent: false,
      rate_limit: 'global',
      step_up: false,
      ...overrides,
    },
  };
}

function session(overrides: Partial<ResolvedSession> = {}): ResolvedSession {
  return {
    session_id: 's1',
    user_id: 'u1',
    account_state: 'active',
    permissions: [],
    restrictions: [],
    age_band: 'adult',
    parental_controls: null,
    amr: ['email'],
    acr: 'aal1',
    step_up_at: null,
    legal_acceptance_required: false,
    expires_at: new Date(NOW + 86_400_000).toISOString(),
    ...overrides,
  };
}

const options = { stepUpWindow: 600_000, now: NOW };
const code = (route: TableRoute, caller: ResolvedSession | null) =>
  checkPolicy(route, caller, options)?.code ?? null;

describe('checkPolicy', () => {
  it('lets anyone through auth: none routes', () => {
    expect(code(table({ auth: 'none' }), null)).toBeNull();
  });

  it('needs a session for session routes', () => {
    expect(code(table(), null)).toBe('AUTHENTICATION_REQUIRED');
    expect(code(table(), session())).toBeNull();
  });

  it('refuses OAuth, service and game routes until they have a verifier', () => {
    for (const auth of ['oauth', 'service', 'game_authoritative'] as const) {
      expect(code(table({ auth }), session())).toBe('AUTHENTICATION_REQUIRED');
    }
  });

  it('returns a specific code for each account state', () => {
    expect(code(table(), session({ account_state: 'banned' }))).toBe('ACCOUNT_BANNED');
    expect(code(table(), session({ account_state: 'locked' }))).toBe('ACCOUNT_LOCKED');
    expect(checkPolicy(table(), session({ account_state: 'pending_deletion' }), options)).toEqual({
      code: 'ACCOUNT_STATE_NOT_ALLOWED',
      extensions: { account_state: 'pending_deletion' },
    });
    expect(
      code(
        table({ allow_account_states: ['active', 'banned'] }),
        session({ account_state: 'banned' }),
      ),
    ).toBeNull();
  });

  it('gates pending parental consent and legal acceptance unless the route allows them', () => {
    const child = session({ account_state: 'pending_parental_consent' });
    expect(code(table(), child)).toBe('PARENTAL_CONSENT_PENDING');
    expect(code(table({ allow_pending_parental_consent: true }), child)).toBeNull();

    const pending = session({ legal_acceptance_required: true });
    expect(code(table(), pending)).toBe('LEGAL_ACCEPTANCE_REQUIRED');
    expect(code(table({ allow_pending_legal: true }), pending)).toBeNull();
  });

  it('checks permissions, honouring wildcard: false', () => {
    const route = table({ permissions: ['users.read'] });
    expect(code(route, session())).toBe('PERMISSION_DENIED');
    expect(code(route, session({ permissions: ['users.*'] }))).toBeNull();
    const csea = table({ permissions: ['safety.csea.access'] });
    expect(code(csea, session({ permissions: ['*'] }))).toBe('PERMISSION_DENIED');
    expect(code(table({ permissions: ['undeclared.perm'] }), session({ permissions: ['*'] }))).toBe(
      'PERMISSION_DENIED',
    );
  });

  it('needs aal2 within the step-up window', () => {
    const route = table({ step_up: true });
    const at = (ms: number) => new Date(NOW - ms).toISOString();
    expect(code(route, session())).toBe('STEP_UP_REQUIRED');
    expect(code(route, session({ acr: 'aal2', step_up_at: at(60_000) }))).toBeNull();
    expect(code(route, session({ acr: 'aal2', step_up_at: at(600_001) }))).toBe('STEP_UP_REQUIRED');
    expect(code(route, session({ acr: 'aal1', step_up_at: at(1) }))).toBe('STEP_UP_REQUIRED');
    expect(code(route, session({ acr: 'aal2' }))).toBe('STEP_UP_REQUIRED');
  });
});

describe('identityFor', () => {
  it('describes the signed-in caller on session routes', () => {
    expect(identityFor(table(), session({ permissions: ['users.read'] }), 'req-1')).toEqual({
      request_id: 'req-1',
      auth: 'session',
      sub: 'u1',
      sid: 's1',
      client_id: null,
      scopes: [],
      permissions: ['users.read'],
      account_state: 'active',
      restrictions: [],
      age_band: 'adult',
      parental_controls: null,
      amr: ['email'],
      acr: 'aal1',
    });
  });

  it('is anonymous on auth: none routes even with a session', () => {
    expect(identityFor(table({ auth: 'none' }), session(), 'req-2')).toMatchObject({
      auth: 'none',
      sub: null,
      permissions: [],
      account_state: null,
    });
  });
});

describe('impliedGatewayErrors', () => {
  it('lists the gates that apply to the route', () => {
    expect(impliedGatewayErrors(table({ auth: 'none' }))).not.toContain('AUTHENTICATION_REQUIRED');
    const guarded = impliedGatewayErrors(table({ method: 'POST', step_up: true }));
    expect(guarded).toEqual(
      expect.arrayContaining([
        'RATE_LIMITED',
        'ORIGIN_NOT_ALLOWED',
        'PAYLOAD_TOO_LARGE',
        'LEGAL_ACCEPTANCE_REQUIRED',
        'PARENTAL_CONSENT_PENDING',
        'STEP_UP_REQUIRED',
      ]),
    );
    expect(impliedGatewayErrors(table({ allow_pending_legal: true }))).not.toContain(
      'LEGAL_ACCEPTANCE_REQUIRED',
    );
  });
});
