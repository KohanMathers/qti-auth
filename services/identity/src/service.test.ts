import { sections } from '@qtiauth/config';
import { openApiDocument } from '@qtiauth/service-kit';
import { describe, expect, it } from 'vitest';

import { definition, router } from './service.ts';

describe('identity service', () => {
  it('ships migrations for the identity schema, starting with the bus tables', async () => {
    expect(definition.database.schema).toBe('identity');
    const migrations = await definition.database.migrations();
    expect(migrations.map((migration) => migration.name)).toEqual([
      '0001_bus_tables',
      '0002_users',
      '0003_sessions',
      '0004_email_tokens',
      '0005_passwords',
      '0006_captcha',
      '0007_factors',
      '0008_social',
      '0009_bindings',
      '0010_session_security',
      '0011_text_filter',
      '0012_usernames',
      '0013_age',
      '0014_roles',
      '0015_audit',
      '0016_legal',
      '0017_admin_users',
      '0018_account_lifecycle',
      '0019_notification_preferences',
      '0020_pre_deletion_state',
      '0021_export_claims',
      '0022_legal_notices',
    ]);
  });

  it('declares every route with a policy the gateway knows', () => {
    const policies = Object.keys(sections.rate_limits.parse({}));
    const { routes } = router.manifest();
    expect(routes.map((route) => `${route.method} ${route.path}`).sort()).toEqual([
      'DELETE /api/v1/admin/filter/allowlist/:word',
      'DELETE /api/v1/admin/filter/blocklist/:word',
      'DELETE /api/v1/admin/roles/:role_id',
      'DELETE /api/v1/me/identities/:identity_id',
      'DELETE /api/v1/me/passkeys/:passkey_id',
      'DELETE /api/v1/sessions/:session_id',
      'GET /api/v1/admin/audit',
      'GET /api/v1/admin/filter/allowlist',
      'GET /api/v1/admin/filter/blocklist',
      'GET /api/v1/admin/filter/blocks',
      'GET /api/v1/admin/filter/unknowns',
      'GET /api/v1/admin/permissions',
      'GET /api/v1/admin/roles',
      'GET /api/v1/admin/roles/:role_id',
      'GET /api/v1/admin/users',
      'GET /api/v1/admin/users/:user_id',
      'GET /api/v1/admin/users/:user_id/roles',
      'GET /api/v1/captcha',
      'GET /api/v1/legal',
      'GET /api/v1/legal/:id',
      'GET /api/v1/legal/:id/:version',
      'GET /api/v1/me',
      'GET /api/v1/me/export/:export_id',
      'GET /api/v1/me/factors',
      'GET /api/v1/me/identities',
      'GET /api/v1/me/legal',
      'GET /api/v1/me/notifications',
      'GET /api/v1/me/passkeys',
      'GET /api/v1/sessions',
      'GET /auth/bind',
      'GET /auth/bind/callback',
      'GET /auth/change-email',
      'GET /auth/delete',
      'GET /auth/export',
      'GET /auth/forgot-password',
      'GET /auth/identities',
      'GET /auth/identities/:provider/connect',
      'GET /auth/login',
      'GET /auth/magic-link',
      'GET /auth/magic-link/start',
      'GET /auth/passkey',
      'GET /auth/passkeys',
      'GET /auth/register',
      'GET /auth/reset-password',
      'GET /auth/revert-email',
      'GET /auth/signup',
      'GET /auth/social/:provider/callback',
      'GET /auth/social/:provider/start',
      'GET /auth/social/signup',
      'GET /auth/totp',
      'GET /auth/two-factor',
      'GET /auth/username',
      'GET /auth/verify-email',
      'GET /legal',
      'GET /legal/:id',
      'GET /legal/:id/:version',
      'GET /legal/accept',
      'PATCH /api/v1/admin/roles/:role_id',
      'PATCH /api/v1/me/notifications',
      'POST /api/v1/admin/filter/allowlist',
      'POST /api/v1/admin/filter/blocklist',
      'POST /api/v1/admin/roles',
      'POST /api/v1/admin/users/:user_id/ban',
      'POST /api/v1/admin/users/:user_id/date-of-birth',
      'POST /api/v1/admin/users/:user_id/lock',
      'POST /api/v1/admin/users/:user_id/reauth',
      'POST /api/v1/admin/users/:user_id/sessions/revoke',
      'POST /api/v1/admin/users/:user_id/unban',
      'POST /api/v1/admin/users/:user_id/unlock',
      'POST /api/v1/admin/users/:user_id/username-reset',
      'POST /api/v1/auth/2fa',
      'POST /api/v1/auth/email/change',
      'POST /api/v1/auth/email/revert',
      'POST /api/v1/auth/email/verify',
      'POST /api/v1/auth/email/verify/start',
      'POST /api/v1/auth/logout',
      'POST /api/v1/auth/magic-link/signup',
      'POST /api/v1/auth/magic-link/start',
      'POST /api/v1/auth/magic-link/verify',
      'POST /api/v1/auth/passkey/authenticate',
      'POST /api/v1/auth/passkey/authenticate/start',
      'POST /api/v1/auth/password/forgot',
      'POST /api/v1/auth/password/login',
      'POST /api/v1/auth/password/reset',
      'POST /api/v1/auth/password/signup',
      'POST /api/v1/auth/social/:provider/start',
      'POST /api/v1/auth/social/complete',
      'POST /api/v1/auth/social/signup',
      'POST /api/v1/me/deletion',
      'POST /api/v1/me/email',
      'POST /api/v1/me/export',
      'POST /api/v1/me/identities/:provider/connect',
      'POST /api/v1/me/legal/accept',
      'POST /api/v1/me/passkeys/:passkey_id',
      'POST /api/v1/me/passkeys/register',
      'POST /api/v1/me/passkeys/register/start',
      'POST /api/v1/me/password',
      'POST /api/v1/me/recovery-codes',
      'POST /api/v1/me/step-up',
      'POST /api/v1/me/step-up/passkey',
      'POST /api/v1/me/step-up/passkey/start',
      'POST /api/v1/me/totp',
      'POST /api/v1/me/totp/disable',
      'POST /api/v1/me/totp/start',
      'POST /api/v1/me/username',
      'POST /api/v1/sessions/revoke-all',
      'POST /api/v1/sessions/revoke-others',
      'POST /auth/change-email',
      'POST /auth/delete',
      'POST /auth/export',
      'POST /auth/forgot-password',
      'POST /auth/login',
      'POST /auth/magic-link',
      'POST /auth/magic-link/start',
      'POST /auth/register',
      'POST /auth/reset-password',
      'POST /auth/revert-email',
      'POST /auth/signup',
      'POST /auth/social/signup',
      'POST /auth/totp',
      'POST /auth/two-factor',
      'POST /auth/username',
      'POST /auth/verify-email',
      'POST /legal/accept',
      'PUT /api/v1/admin/users/:user_id/roles',
    ]);
    for (const route of routes) {
      expect(policies, `${route.method} ${route.path}`).toContain(route.rate_limit);
      expect(route.module).toBe('core');
    }
  });

  it('rate-limits magic links by address and IP, and lets anyone sign out', () => {
    const route = (method: string, path: string) =>
      router.manifest().routes.find((r) => r.method === method && r.path === path);
    expect(route('POST', '/api/v1/auth/magic-link/start')).toMatchObject({
      auth: 'none',
      rate_limit: 'magic_link',
    });
    expect(route('POST', '/api/v1/auth/magic-link/verify')).toMatchObject({
      auth: 'none',
      rate_limit: 'auth_verify',
    });
    expect(route('POST', '/api/v1/auth/logout')).toMatchObject({
      auth: 'session',
      allow_pending_legal: true,
      allow_pending_parental_consent: true,
      allow_pending_2fa_enrolment: true,
      allow_aal0: true,
      allow_account_states: expect.arrayContaining(['active', 'banned', 'locked']) as unknown,
    });
    expect(route('POST', '/api/v1/auth/password/login')).toMatchObject({
      auth: 'none',
      rate_limit: 'auth_password',
    });
    expect(route('GET', '/api/v1/captcha')).toMatchObject({
      auth: 'none',
      rate_limit: 'global',
    });
    expect(route('POST', '/api/v1/auth/password/forgot')).toMatchObject({
      rate_limit: 'magic_link',
    });
    expect(route('POST', '/api/v1/me/password')).toMatchObject({
      auth: 'session',
      rate_limit: 'global',
    });
    expect(route('POST', '/api/v1/me/recovery-codes')).toMatchObject({
      auth: 'session',
      step_up: true,
    });
    expect(route('POST', '/api/v1/me/email')).toMatchObject({
      auth: 'session',
      step_up: true,
    });
    expect(route('POST', '/api/v1/me/deletion')).toMatchObject({
      auth: 'session',
      step_up: true,
    });
    expect(route('POST', '/api/v1/me/export')).toMatchObject({
      auth: 'session',
      step_up: true,
    });
    expect(route('POST', '/api/v1/admin/users/:user_id/date-of-birth')).toMatchObject({
      auth: 'session',
      permissions: ['users.edit_dob'],
      step_up: true,
    });
    expect(route('GET', '/api/v1/admin/users')).toMatchObject({
      auth: 'session',
      permissions: ['users.read'],
    });
    expect(route('GET', '/api/v1/admin/users/:user_id')).toMatchObject({
      auth: 'session',
      permissions: ['users.read'],
    });
    expect(route('POST', '/api/v1/admin/users/:user_id/ban')).toMatchObject({
      auth: 'session',
      permissions: ['users.ban'],
      step_up: true,
    });
    expect(route('POST', '/api/v1/admin/users/:user_id/lock')).toMatchObject({
      auth: 'session',
      permissions: ['users.lock'],
      step_up: true,
    });
    expect(route('POST', '/api/v1/admin/users/:user_id/username-reset')).toMatchObject({
      auth: 'session',
      permissions: ['users.force_username_reset'],
      step_up: true,
    });
    expect(route('POST', '/api/v1/me/username')).toMatchObject({
      auth: 'session',
      allow_account_states: expect.arrayContaining(['active', 'banned', 'locked']) as unknown,
    });
    expect(route('GET', '/api/v1/admin/permissions')).toMatchObject({
      auth: 'session',
      permissions: ['roles.manage'],
    });
    expect(route('POST', '/api/v1/admin/roles')).toMatchObject({
      auth: 'session',
      permissions: ['roles.manage'],
      step_up: true,
    });
    expect(route('GET', '/api/v1/admin/audit')).toMatchObject({
      auth: 'session',
      permissions: ['audit.read'],
    });
    expect(route('GET', '/api/v1/legal')).toMatchObject({
      auth: 'none',
      rate_limit: 'global',
    });
    expect(route('POST', '/api/v1/me/legal/accept')).toMatchObject({
      auth: 'session',
      allow_pending_legal: true,
    });
    expect(route('GET', '/api/v1/me/notifications')).toMatchObject({
      auth: 'session',
      allow_account_states: expect.arrayContaining(['active', 'banned', 'locked']) as unknown,
    });
    expect(route('PATCH', '/api/v1/me/notifications')).toMatchObject({
      auth: 'session',
      allow_account_states: expect.arrayContaining(['active', 'banned', 'locked']) as unknown,
    });
    expect(route('POST', '/api/v1/auth/social/:provider/start')).toMatchObject({
      auth: 'none',
      rate_limit: 'auth_password',
    });
    expect(route('POST', '/api/v1/me/identities/:provider/connect')).toMatchObject({
      auth: 'session',
      rate_limit: 'auth_password',
    });
    expect(route('POST', '/api/v1/me/totp/start')).toMatchObject({
      auth: 'session',
      allow_pending_2fa_enrolment: true,
    });
    expect(route('GET', '/auth/bind')).toMatchObject({
      auth: 'session',
      allow_pending_legal: true,
      allow_pending_parental_consent: true,
      allow_pending_2fa_enrolment: true,
    });
    expect(route('GET', '/auth/bind/callback')).toMatchObject({
      auth: 'none',
      rate_limit: 'auth_verify',
    });
    expect(route('GET', '/api/v1/sessions')).toMatchObject({
      auth: 'session',
      allow_account_states: ['active'],
    });
    expect(route('POST', '/api/v1/me/deletion')).toMatchObject({
      auth: 'session',
      step_up: true,
    });
    expect(route('POST', '/api/v1/me/export')).toMatchObject({
      auth: 'session',
      step_up: true,
    });
    expect(route('GET', '/api/v1/me/export/:export_id')).toMatchObject({
      auth: 'session',
      step_up: false,
    });
  });

  it('registers notification categories, with security and legal not disableable', () => {
    expect(router.manifest().notifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'identity.security',
          disableable: false,
          audience: 'user',
        }),
        expect.objectContaining({ name: 'identity.legal', disableable: false, audience: 'user' }),
        expect.objectContaining({
          name: 'support.ticket_updates',
          disableable: true,
          audience: 'user',
        }),
        expect.objectContaining({ name: 'support.new_tickets', audience: 'staff' }),
        expect.objectContaining({ name: 'safety.high_priority_reports', audience: 'staff' }),
      ]),
    );
  });

  it('lists its error codes in OpenAPI', () => {
    const document = openApiDocument(router) as {
      'x-qtiauth-errors': { code: string }[];
      paths: Record<string, unknown>;
    };
    expect(document['x-qtiauth-errors'].map((error) => error.code)).toEqual(
      expect.arrayContaining([
        'MAGIC_LINK_INVALID',
        'ACCOUNT_LIMIT_REACHED',
        'SESSION_NOT_FOUND',
        'CREDENTIALS_INCORRECT',
        'PASSWORD_REJECTED',
        'CAPTCHA_REQUIRED',
        'PASSKEY_INVALID',
        'STEP_UP_REQUIRED',
        'LAST_SIGN_IN_METHOD',
        'OAUTH_FAILED',
        'EMAIL_CHANGE_INVALID',
        'EMAIL_REVERT_INVALID',
        'USERNAME_UNAVAILABLE',
        'DATE_OF_BIRTH_UNCHANGED',
        'ROLE_NOT_FOUND',
        'ROLE_SLUG_TAKEN',
        'ROLE_BUILTIN',
        'LEGAL_DOCUMENT_NOT_FOUND',
        'ACCOUNT_SELF',
        'ACCOUNT_STATE_CONFLICT',
        'LOCK_EXPIRY_INVALID',
        'EXPORT_NOT_FOUND',
        'DELETION_NOT_PENDING',
        'NOTIFICATION_REQUIRED',
        'NOTIFICATION_CATEGORY_NOT_FOUND',
      ]),
    );
    expect(JSON.stringify(document.paths['/api/v1/auth/magic-link/signup'])).toContain(
      'PARENTAL_CONSENT_UNAVAILABLE',
    );
  });
});
