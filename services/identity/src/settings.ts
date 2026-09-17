import { emailNormalizer } from './email.ts';
import type { MagicLinkSettings } from './magic-links.ts';
import type { IdentityConfig } from './service.ts';
import type { SessionClient, SessionSettings } from './sessions.ts';

export const MAGIC_LINK_PAGE = '/auth/magic-link';

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
