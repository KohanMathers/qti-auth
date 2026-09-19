import {
  type Identity,
  type KitErrorCode,
  missingPermissions,
  type ResolvedAccessToken,
  type ResolvedSession,
} from '@qtiauth/service-kit';

import type { GatewayErrorCode } from './errors.ts';
import type { TableRoute } from './routes.ts';

export interface PolicyDenial {
  code: GatewayErrorCode | KitErrorCode;
  extensions?: Record<string, unknown>;
}

export interface PolicyOptions {
  stepUpWindow: number;
  now: number;
}

const STATE_ERRORS: Partial<Record<ResolvedSession['account_state'], GatewayErrorCode>> = {
  banned: 'ACCOUNT_BANNED',
  locked: 'ACCOUNT_LOCKED',
  pending_parental_consent: 'PARENTAL_CONSENT_PENDING',
};

function accountStateDenial(
  route: TableRoute['route'],
  state: ResolvedSession['account_state'],
): PolicyDenial | null {
  const stateAllowed =
    route.allow_account_states.includes(state) ||
    (state === 'pending_parental_consent' && route.allow_pending_parental_consent);
  if (stateAllowed) return null;
  return {
    code: STATE_ERRORS[state] ?? 'ACCOUNT_STATE_NOT_ALLOWED',
    extensions: { account_state: state },
  };
}

export function checkPolicy(
  table: TableRoute,
  session: ResolvedSession | null,
  options: PolicyOptions,
  oauth: ResolvedAccessToken | null = null,
): PolicyDenial | null {
  const { route } = table;
  if (route.auth === 'none') return null;
  if (route.auth === 'oauth') {
    if (oauth === null) return { code: 'AUTHENTICATION_REQUIRED' };
    const state = accountStateDenial(route, oauth.account_state);
    if (state) return state;
    const missing = route.scopes.filter((scope) => !oauth.scopes.includes(scope));
    if (missing.length > 0) {
      return { code: 'INSUFFICIENT_SCOPE', extensions: { missing_scopes: missing } };
    }
    return null;
  }
  if (route.auth !== 'session' || session === null) return { code: 'AUTHENTICATION_REQUIRED' };

  const state = accountStateDenial(route, session.account_state);
  if (state) return state;

  if (session.legal_acceptance_required && !route.allow_pending_legal) {
    return { code: 'LEGAL_ACCEPTANCE_REQUIRED' };
  }

  if (session.two_factor_enrolment_required && !route.allow_pending_2fa_enrolment) {
    return { code: 'TWO_FACTOR_ENROLMENT_REQUIRED' };
  }

  if (session.acr === 'aal0' && !route.allow_aal0) {
    return { code: 'REAUTHENTICATION_REQUIRED' };
  }

  const required = route.permissions.map(
    (name) => table.permissions.get(name) ?? { name, description: '', wildcard: false },
  );
  if (missingPermissions(session.permissions, required).length > 0) {
    return { code: 'PERMISSION_DENIED' };
  }

  if (route.step_up) {
    const steppedUp = session.step_up_at === null ? Number.NaN : Date.parse(session.step_up_at);
    const recent = session.acr === 'aal2' && options.now - steppedUp <= options.stepUpWindow;
    if (!recent) return { code: 'STEP_UP_REQUIRED' };
  }
  return null;
}

export function impliedGatewayErrors(table: TableRoute): (GatewayErrorCode | KitErrorCode)[] {
  const { route } = table;
  const codes: (GatewayErrorCode | KitErrorCode)[] = [
    'RATE_LIMITED',
    'RATE_LIMIT_UNAVAILABLE',
    'SERVICE_UNAVAILABLE',
    'UPSTREAM_TIMEOUT',
  ];
  if (route.method !== 'GET' && route.method !== 'DELETE') codes.push('PAYLOAD_TOO_LARGE');
  if (route.method !== 'GET') codes.push('ORIGIN_NOT_ALLOWED');
  if (route.auth === 'none') return codes;
  codes.push('AUTHENTICATION_REQUIRED', 'ACCOUNT_BANNED', 'ACCOUNT_LOCKED');
  if (route.auth === 'oauth') {
    if (route.scopes.length > 0) codes.push('INSUFFICIENT_SCOPE');
    return codes;
  }
  if (!route.allow_pending_parental_consent) codes.push('PARENTAL_CONSENT_PENDING');
  if (!route.allow_pending_legal) codes.push('LEGAL_ACCEPTANCE_REQUIRED');
  if (!route.allow_pending_2fa_enrolment) codes.push('TWO_FACTOR_ENROLMENT_REQUIRED');
  if (!route.allow_aal0) codes.push('REAUTHENTICATION_REQUIRED');
  if (route.step_up) codes.push('STEP_UP_REQUIRED');
  return codes;
}

export function identityFor(
  table: TableRoute,
  session: ResolvedSession | null,
  requestId: string,
  oauth: ResolvedAccessToken | null = null,
): Identity {
  if (table.route.auth === 'oauth' && oauth !== null) {
    return {
      request_id: requestId,
      auth: 'oauth',
      sub: oauth.sub,
      sid: oauth.sid,
      client_id: oauth.client_id,
      scopes: oauth.scopes,
      permissions: [],
      account_state: oauth.account_state,
      restrictions: oauth.restrictions,
      age_band: oauth.age_band,
      parental_controls: oauth.parental_controls,
      amr: oauth.amr,
      acr: oauth.acr,
    };
  }
  const signedIn = table.route.auth === 'session' && session !== null;
  return {
    request_id: requestId,
    auth: table.route.auth,
    sub: signedIn ? session.user_id : null,
    sid: session?.session_id ?? null,
    client_id: null,
    scopes: [],
    permissions: signedIn ? session.permissions : [],
    account_state: signedIn ? session.account_state : null,
    restrictions: signedIn ? session.restrictions : [],
    age_band: signedIn ? session.age_band : null,
    parental_controls: signedIn ? session.parental_controls : null,
    amr: signedIn ? session.amr : [],
    acr: signedIn ? session.acr : null,
  };
}
