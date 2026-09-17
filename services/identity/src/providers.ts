import { BUILTIN_SOCIAL_IDS, type QtiauthConfig } from '@qtiauth/config';

export const GOOGLE_AUTHORIZATION = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
export const GOOGLE_USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo';
export const GITHUB_AUTHORIZATION = 'https://github.com/login/oauth/authorize';
export const GITHUB_TOKEN = 'https://github.com/login/oauth/access_token';
export const GITHUB_USER = 'https://api.github.com/user';
export const GITHUB_EMAILS = 'https://api.github.com/user/emails';
export const DISCORD_AUTHORIZATION = 'https://discord.com/oauth2/authorize';
export const DISCORD_TOKEN = 'https://discord.com/api/oauth2/token';
export const DISCORD_USER = 'https://discord.com/api/users/@me';

export type SocialProtocol = 'oidc' | 'oauth' | 'steam';

export interface SocialProvider {
  id: string;
  type: string;
  name: string;
  protocol: SocialProtocol;
  clientId: string;
  clientSecret: string;
  scopes: string[];
  authorizationEndpoint: string | null;
  tokenEndpoint: string | null;
  userinfoEndpoint: string | null;
  emailsEndpoint: string | null;
  issuer: string | null;
  usePkce: boolean;
  useNonce: boolean;
}

export type SocialConfig = QtiauthConfig['features']['auth']['social'];

export function identityType(id: string): string {
  if ((BUILTIN_SOCIAL_IDS as readonly string[]).includes(id)) return id;
  return `oidc:${id}`;
}

export function metricMethod(type: string): string {
  return type.startsWith('oidc:') ? 'oidc' : type;
}

export function socialAmr(type: string): string[] {
  return [metricMethod(type)];
}

export function anySocialEnabled(social: SocialConfig): boolean {
  return (
    social.google.enabled ||
    social.github.enabled ||
    social.discord.enabled ||
    social.steam.enabled ||
    social.generic_oidc.length > 0
  );
}

export function enabledSocialProviders(social: SocialConfig): SocialProvider[] {
  const providers: SocialProvider[] = [];
  for (const id of BUILTIN_SOCIAL_IDS) {
    const provider = builtinProvider(social, id);
    if (provider !== undefined) providers.push(provider);
  }
  for (const item of social.generic_oidc) {
    providers.push({
      id: item.id,
      type: identityType(item.id),
      name: item.name,
      protocol: 'oidc',
      clientId: item.client_id,
      clientSecret: item.client_secret,
      scopes: item.scopes,
      authorizationEndpoint: null,
      tokenEndpoint: null,
      userinfoEndpoint: null,
      emailsEndpoint: null,
      issuer: item.issuer,
      usePkce: true,
      useNonce: true,
    });
  }
  return providers;
}

export function findSocialProvider(social: SocialConfig, id: string): SocialProvider | undefined {
  if ((BUILTIN_SOCIAL_IDS as readonly string[]).includes(id)) {
    return builtinProvider(social, id as (typeof BUILTIN_SOCIAL_IDS)[number]);
  }
  const item = social.generic_oidc.find((candidate) => candidate.id === id);
  if (item === undefined) return undefined;
  return {
    id: item.id,
    type: identityType(item.id),
    name: item.name,
    protocol: 'oidc',
    clientId: item.client_id,
    clientSecret: item.client_secret,
    scopes: item.scopes,
    authorizationEndpoint: null,
    tokenEndpoint: null,
    userinfoEndpoint: null,
    emailsEndpoint: null,
    issuer: item.issuer,
    usePkce: true,
    useNonce: true,
  };
}

function builtinProvider(
  social: SocialConfig,
  id: (typeof BUILTIN_SOCIAL_IDS)[number],
): SocialProvider | undefined {
  if (id === 'steam') {
    if (!social.steam.enabled) return undefined;
    return {
      id,
      type: id,
      name: 'Steam',
      protocol: 'steam',
      clientId: '',
      clientSecret: '',
      scopes: [],
      authorizationEndpoint: null,
      tokenEndpoint: null,
      userinfoEndpoint: null,
      emailsEndpoint: null,
      issuer: null,
      usePkce: false,
      useNonce: false,
    };
  }
  const settings = social[id];
  if (!settings.enabled) return undefined;
  if (id === 'google') {
    return {
      id,
      type: id,
      name: 'Google',
      protocol: 'oidc',
      clientId: settings.client_id,
      clientSecret: settings.client_secret,
      scopes: ['openid', 'email', 'profile'],
      authorizationEndpoint: GOOGLE_AUTHORIZATION,
      tokenEndpoint: GOOGLE_TOKEN,
      userinfoEndpoint: GOOGLE_USERINFO,
      emailsEndpoint: null,
      issuer: 'https://accounts.google.com',
      usePkce: true,
      useNonce: true,
    };
  }
  if (id === 'github') {
    return {
      id,
      type: id,
      name: 'GitHub',
      protocol: 'oauth',
      clientId: settings.client_id,
      clientSecret: settings.client_secret,
      scopes: ['read:user', 'user:email'],
      authorizationEndpoint: GITHUB_AUTHORIZATION,
      tokenEndpoint: GITHUB_TOKEN,
      userinfoEndpoint: GITHUB_USER,
      emailsEndpoint: GITHUB_EMAILS,
      issuer: null,
      usePkce: true,
      useNonce: false,
    };
  }
  return {
    id,
    type: id,
    name: 'Discord',
    protocol: 'oauth',
    clientId: settings.client_id,
    clientSecret: settings.client_secret,
    scopes: ['identify', 'email'],
    authorizationEndpoint: DISCORD_AUTHORIZATION,
    tokenEndpoint: DISCORD_TOKEN,
    userinfoEndpoint: DISCORD_USER,
    emailsEndpoint: null,
    issuer: null,
    usePkce: true,
    useNonce: false,
  };
}
