import { emailNormalizer } from './email.ts';
import { parseEncryptionKey } from './encrypt.ts';
import type { EmailChangeSettings } from './email-change.ts';
import type { MagicLinkSettings } from './magic-links.ts';
import type { RelyingParty } from './passkeys.ts';
import type { PasswordSettings } from './password-auth.ts';
import type { IdentityConfig } from './service.ts';
import type { SessionClient, SessionSettings } from './sessions.ts';
import type { SocialSettings } from './social.ts';

export const MAGIC_LINK_PAGE = '/auth/magic-link';
export const MAGIC_LINK_START_PAGE = '/auth/magic-link/start';
export const SIGNUP_CHOICE_PAGE = '/auth/signup';
export const REGISTER_PAGE = '/auth/register';
export const LOGIN_PAGE = '/auth/login';
export const FORGOT_PASSWORD_PAGE = '/auth/forgot-password';
export const RESET_PASSWORD_PAGE = '/auth/reset-password';
export const VERIFY_EMAIL_PAGE = '/auth/verify-email';
export const PASSKEY_PAGE = '/auth/passkey';
export const TWO_FACTOR_PAGE = '/auth/two-factor';
export const TOTP_PAGE = '/auth/totp';
export const PASSKEYS_PAGE = '/auth/passkeys';
export const SOCIAL_START_PAGE = '/auth/social/:provider/start';
export const SOCIAL_CALLBACK_PAGE = '/auth/social/:provider/callback';
export const SOCIAL_SIGNUP_PAGE = '/auth/social/signup';
export const IDENTITIES_PAGE = '/auth/identities';
export const CONNECT_PAGE = '/auth/identities/:provider/connect';
export const CHANGE_EMAIL_PAGE = '/auth/change-email';
export const REVERT_EMAIL_PAGE = '/auth/revert-email';

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
    bands: config.age.bands,
    normalizeEmail,
    sessions: sessionSettings(config),
  };
}

export function sessionClient(
  config: Pick<IdentityConfig, 'cookies'>,
  request: Request,
): SessionClient {
  return {
    userAgent: request.headers.get('user-agent'),
    cookieScope: config.cookies.domain ?? request.headers.get('x-forwarded-host') ?? '',
  };
}

export function accountOrigin(config: Pick<IdentityConfig, 'surfaces'>): string {
  const { account } = config.surfaces;
  const origin = account.origins?.[0] ?? (account.hosts[0] && `https://${account.hosts[0]}`);
  if (!origin) {
    throw new IdentityConfigError(
      'surfaces.account needs origins when it has no hosts, so identity can link to it in emails',
    );
  }
  return origin;
}

export function accountPath(config: Pick<IdentityConfig, 'surfaces'>, path: string): string {
  const base = config.surfaces.account.base_path;
  return base === '/' ? path : `${base}${path}`;
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
    bands: config.age.bands,
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

export function emailChangeSettings(config: IdentityConfig): EmailChangeSettings {
  return {
    changeTtl: config.accounts.email_change_ttl,
    revertTtl: config.accounts.email_revert_ttl,
    maxPerEmail: config.accounts.max_per_email,
    normalizeEmail: magicLinkSettings(config).normalizeEmail,
  };
}

export function socialSettings(config: IdentityConfig): SocialSettings {
  const magic = magicLinkSettings(config);
  return {
    maxPerEmail: magic.maxPerEmail,
    consentAge: magic.consentAge,
    bands: magic.bands,
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
