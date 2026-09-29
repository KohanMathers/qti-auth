import { SURFACES } from '@qtiauth/config';
import { normalizeCountry } from '@qtiauth/geoip';
import {
  SESSION_CLIENT_FINGERPRINT_HEADER,
  SESSION_COUNTRY_HEADER,
  SESSION_SCREEN_HEADER,
  SESSION_TIMEZONE_HEADER,
} from '@qtiauth/service-kit';

import { emailNormalizer } from './email.ts';
import type { EmailChangeSettings } from './email-change.ts';
import { parseEncryptionKey } from './encrypt.ts';
import { geoIpOf } from './geoip-state.ts';
import type { MagicLinkSettings } from './magic-links.ts';
import type { ParentalSettings } from './parental.ts';
import type { RelyingParty } from './passkeys.ts';
import type { PasswordSettings } from './password-auth.ts';
import type { SessionSecuritySettings } from './security.ts';
import type { Context, IdentityConfig } from './service.ts';
import type { SessionClient, SessionSettings } from './sessions.ts';
import type { SocialSettings } from './social.ts';

export const RETURN_TO = /^\/(?![/\\])[^\s\\]*$/;
export const MAGIC_LINK_PAGE = '/verify';
export const RESET_PASSWORD_PAGE = '/reset';
export const VERIFY_EMAIL_PAGE = '/verify';
export const SOCIAL_CALLBACK_PAGE = '/auth/social/:provider/callback';
export const CHANGE_EMAIL_PAGE = '/verify';
export const REVERT_EMAIL_PAGE = '/revert-email';
export const GUARDIAN_APPROVE_PAGE = '/guardian/approve';
export const GUARDIAN_DECLINE_PAGE = '/guardian/decline';
export const FAMILY_PAGE = '/family';
export const FAMILY_SESSION_PAGE = '/family/session';
export const FAMILY_INVITE_PAGE = '/family/invite';
export const FAMILY_LEAVE_PAGE = '/family/leave';

export class IdentityConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdentityConfigError';
  }
}

const normalizers = new WeakMap<IdentityConfig['accounts'], (address: string) => string>();

export function sessionSettings(
  config: Pick<IdentityConfig, 'cookies' | 'sessions'>,
): SessionSettings {
  return {
    sessionTtl: config.cookies.session_ttl,
    idleTimeout: config.cookies.idle_timeout,
    maxPerUser: config.sessions.max_per_user,
  };
}

export function magicLinkSettings(config: IdentityConfig): MagicLinkSettings {
  let normalizeEmail = normalizers.get(config.accounts);
  if (!normalizeEmail) {
    normalizeEmail = emailNormalizer(config.accounts.email_normalization);
    normalizers.set(config.accounts, normalizeEmail);
  }
  return {
    ttl: config.magic_link.ttl,
    signupTtl: config.magic_link.signup_ttl,
    maxPerEmail: config.accounts.max_per_email,
    consentAge: config.parental.consent_age,
    pendingTtl: config.parental.pending_ttl,
    bands: config.age.bands,
    defaultProvider: config.age.assurance.default_provider,
    requiredFor: config.age.assurance.required_for,
    normalizeEmail,
    sessions: sessionSettings(config),
  };
}

export function sessionSecuritySettings(
  config: Pick<IdentityConfig, 'features' | 'session_security'>,
): SessionSecuritySettings {
  return {
    enabled: config.features.session_security.enabled,
    onCountryChange: config.session_security.on_country_change,
    alertMinInterval: config.session_security.alert_min_interval,
  };
}

export function sessionClient(
  config: Pick<IdentityConfig, 'cookies' | 'geoip' | 'session_security'>,
  request: Request,
  extras: { sid?: string | null; lookupCountry?: (ip: string) => string | null } = {},
): SessionClient {
  const ip = clientIp(request);
  const countryHeader =
    request.headers.get(SESSION_COUNTRY_HEADER) ??
    (config.geoip.source === 'header' && config.geoip.header !== null
      ? request.headers.get(config.geoip.header)
      : null);
  const tlsHeader = config.session_security.tls_fingerprint.header;
  return {
    userAgent: request.headers.get('user-agent'),
    cookieScope: config.cookies.domain ?? request.headers.get('x-forwarded-host') ?? '',
    ip,
    tlsFingerprint: tlsHeader === null ? null : request.headers.get(tlsHeader),
    country: normalizeCountry(countryHeader) ?? extras.lookupCountry?.(ip) ?? null,
    timezone: request.headers.get(SESSION_TIMEZONE_HEADER),
    screen: request.headers.get(SESSION_SCREEN_HEADER),
    clientFingerprint: request.headers.get(SESSION_CLIENT_FINGERPRINT_HEADER),
    restoreSessionId: extras.sid ?? null,
  };
}

export function clientFor(
  ctx: Context,
  request: Request,
  identity?: { sid: string | null } | null,
): SessionClient {
  return sessionClient(ctx.config, request, {
    sid: identity?.sid ?? null,
    lookupCountry: (ip) => geoIpOf(ctx)?.lookup(ip) ?? null,
  });
}

export type SurfaceName = (typeof SURFACES)[number];

export function surfaceOrigin(
  config: Pick<IdentityConfig, 'surfaces'>,
  name: SurfaceName,
): string | undefined {
  const surface = config.surfaces[name];
  return surface.origins?.[0] ?? (surface.hosts[0] && `https://${surface.hosts[0]}`);
}

export function surfacePath(
  config: Pick<IdentityConfig, 'surfaces'>,
  name: SurfaceName,
  path: string,
): string {
  const base = config.surfaces[name].base_path;
  return base === '/' ? path : `${base}${path}`;
}

export function surfaceUrl(
  config: Pick<IdentityConfig, 'surfaces'>,
  name: SurfaceName,
  path: string,
): string | undefined {
  const origin = surfaceOrigin(config, name);
  if (origin === undefined) return undefined;
  return new URL(surfacePath(config, name, path), origin).toString();
}

export function surfaceForHost(
  config: Pick<IdentityConfig, 'surfaces'>,
  host: string,
): SurfaceName | undefined {
  const needle = host.toLowerCase();
  return SURFACES.find((name) => config.surfaces[name].hosts.includes(needle));
}

export function parseBindTarget(
  config: Pick<IdentityConfig, 'surfaces'>,
  target: string,
  returnPath: string,
): { target: SurfaceName; origin: string; returnPath: string } | undefined {
  if (!(SURFACES as readonly string[]).includes(target)) return undefined;
  const name = target as SurfaceName;
  const origin = surfaceOrigin(config, name);
  if (origin === undefined) return undefined;
  if (returnPath.length > 2048 || !RETURN_TO.test(returnPath)) return undefined;
  return { target: name, origin, returnPath };
}

export function accountOrigin(config: Pick<IdentityConfig, 'surfaces'>): string {
  const origin = surfaceOrigin(config, 'account');
  if (!origin) {
    throw new IdentityConfigError(
      'surfaces.account needs origins when it has no hosts, so identity can link to it in emails',
    );
  }
  return origin;
}

export function accountPath(config: Pick<IdentityConfig, 'surfaces'>, path: string): string {
  return surfacePath(config, 'account', path);
}

export function magicLinkUrl(config: Pick<IdentityConfig, 'surfaces'>, token: string): string {
  const url = new URL(accountPath(config, MAGIC_LINK_PAGE), accountOrigin(config));
  url.searchParams.set('token', token);
  return url.toString();
}

export function passwordSettings(config: IdentityConfig): PasswordSettings {
  let normalizeEmail = normalizers.get(config.accounts);
  if (!normalizeEmail) {
    normalizeEmail = emailNormalizer(config.accounts.email_normalization);
    normalizers.set(config.accounts, normalizeEmail);
  }
  return {
    policy: {
      minLength: config.password.min_length,
      maxLength: config.password.max_length,
      requireLower: config.password.composition.require_lower,
      requireUpper: config.password.composition.require_upper,
      requireDigit: config.password.composition.require_digit,
      requireSymbol: config.password.composition.require_symbol,
    },
    argon2: {
      memoryKib: config.password.argon2.memory_kib,
      iterations: config.password.argon2.iterations,
      parallelism: config.password.argon2.parallelism,
    },
    breachCheck: config.password.breach_check,
    resetTtl: config.password.reset_ttl,
    verificationTtl: config.password.verification_ttl,
    failureDelay: {
      step: config.password.failure_delay.step,
      max: config.password.failure_delay.max,
    },
    maxPerEmail: config.accounts.max_per_email,
    consentAge: config.parental.consent_age,
    pendingTtl: config.parental.pending_ttl,
    bands: config.age.bands,
    defaultProvider: config.age.assurance.default_provider,
    requiredFor: config.age.assurance.required_for,
    stepUpWindow: config.security.step_up_window,
    normalizeEmail,
    sessions: sessionSettings(config),
  };
}

export function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded === null) return '';
  return forwarded.split(',')[0]?.trim() ?? '';
}

export function encryptionKey(config: IdentityConfig): Buffer {
  return parseEncryptionKey(config.security.encryption_key, 'security.encryption_key');
}

export function relyingParty(config: Pick<IdentityConfig, 'surfaces' | 'branding'>): RelyingParty {
  const origin = accountOrigin(config);
  const origins = new Set<string>(config.surfaces.account.origins ?? []);
  origins.add(origin);
  for (const host of config.surfaces.account.hosts) origins.add(`https://${host}`);
  return {
    name: config.branding.product_name,
    rpID: new URL(origin).hostname,
    origins: [...origins],
  };
}

export function emailLinkUrl(
  config: Pick<IdentityConfig, 'surfaces'>,
  path: string,
  token: string,
): string {
  const url = new URL(accountPath(config, path), accountOrigin(config));
  url.searchParams.set('token', token);
  return url.toString();
}

export function legalDocumentUrl(config: Pick<IdentityConfig, 'surfaces'>, id: string): string {
  return new URL(accountPath(config, `/legal/${id}`), accountOrigin(config)).toString();
}

export function familyDashboardUrl(config: Pick<IdentityConfig, 'surfaces'>): string {
  return new URL(accountPath(config, FAMILY_PAGE), accountOrigin(config)).toString();
}

export function familyLeaveUrl(config: Pick<IdentityConfig, 'surfaces'>): string {
  return new URL(accountPath(config, FAMILY_LEAVE_PAGE), accountOrigin(config)).toString();
}

export function familyChildUrl(config: Pick<IdentityConfig, 'surfaces'>, childId: string): string {
  return new URL(
    accountPath(config, `/family/${encodeURIComponent(childId)}`),
    accountOrigin(config),
  ).toString();
}

export function emailChangeSettings(config: IdentityConfig): EmailChangeSettings {
  return {
    changeTtl: config.accounts.email_change_ttl,
    revertTtl: config.accounts.email_revert_ttl,
    maxPerEmail: config.accounts.max_per_email,
    normalizeEmail: magicLinkSettings(config).normalizeEmail,
  };
}

export function parentalSettings(config: IdentityConfig): ParentalSettings {
  const magic = magicLinkSettings(config);
  return {
    consentAge: magic.consentAge,
    pendingTtl: magic.pendingTtl,
    maxGuardians: config.parental.max_guardians,
    bands: magic.bands,
    normalizeEmail: magic.normalizeEmail,
  };
}

export function socialSettings(config: IdentityConfig): SocialSettings {
  const magic = magicLinkSettings(config);
  return {
    maxPerEmail: magic.maxPerEmail,
    consentAge: magic.consentAge,
    pendingTtl: magic.pendingTtl,
    bands: magic.bands,
    defaultProvider: magic.defaultProvider,
    requiredFor: magic.requiredFor,
    normalizeEmail: magic.normalizeEmail,
    sessions: magic.sessions,
  };
}

export function socialCallbackUrl(
  config: Pick<IdentityConfig, 'surfaces'>,
  providerId: string,
): string {
  return new URL(
    accountPath(config, `/auth/social/${encodeURIComponent(providerId)}/callback`),
    accountOrigin(config),
  ).toString();
}
