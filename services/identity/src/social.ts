import { randomUUIDv7 } from 'node:crypto';

import { writeEvent } from '@qtiauth/bus';
import type { AgeBand } from '@qtiauth/service-kit';
import type { Expression, ExpressionBuilder, Kysely, SqlBool } from 'kysely';

import {
  accountsWithEmail,
  createUser,
  findAccount,
  initialAccountState,
  lockEmail,
} from './accounts.ts';
import {
  type AgeBands,
  ageBand,
  ageOn,
  agePrivacyDefaults,
  isValidDateOfBirth,
  under18,
} from './age.ts';
import { recordSignupAgeAssurance } from './age-assurance.ts';
import { challengePayload, insertChallenge, takeChallenge, useChallenge } from './challenges.ts';
import type { Database } from './database.ts';
import { type UserCreatedData, userCreatedEvent } from './events.ts';
import { hashToken, newToken } from './tokens.ts';
import {
  authorizationUrl,
  discoverIssuer,
  exchangeAuthorizationCode,
  loadSocialProfile,
  type OidcDiscovery,
  pkceChallenge,
  pkceVerifier,
  type SocialProfile,
} from './oauth.ts';
import {
  OAUTH_STATE_TTL,
  type OauthState,
  type OauthStateStore,
  type SocialIntent,
} from './oauth-state.ts';
import { PASSKEY_METHOD } from './passkeys.ts';
import {
  findSocialProvider,
  type SocialConfig,
  socialAmr,
  type SocialProvider,
} from './providers.ts';
import {
  type CreatedSession,
  createSession,
  type SessionClient,
  type SessionSettings,
} from './sessions.ts';
import { steamAuthorizationUrl, steamReturnTo, verifySteamAssertion } from './steam.ts';

export const SOCIAL_SIGNUP_KIND = 'social_signup' as const;
export const SOCIAL_SIGNUP_TTL = 30 * 60_000;

export interface SocialSettings {
  maxPerEmail: number;
  consentAge: number;
  bands: AgeBands;
  defaultProvider: string;
  requiredFor: readonly string[];
  normalizeEmail: (address: string) => string;
  sessions: SessionSettings;
}

export interface SocialIdentity {
  id: string;
  type: string;
  createdAt: Date;
  lastUsedAt: Date | null;
}

interface SignupPayload {
  provider: string;
  type: string;
  subject: string;
  email: string | null;
  emailVerified: boolean;
  birthdate: string | null;
  locale: string | null;
  returnTo: string | null;
}

export type BeginSocialResult =
  { status: 'disabled' } | { status: 'ok'; url: string; binding: string; expiresAt: Date };

export type CompleteSocialResult =
  | { status: 'invalid' }
  | { status: 'denied' }
  | { status: 'provider_unavailable' }
  | { status: 'identity_in_use' }
  | { status: 'account_limit' }
  | { status: 'parental_consent_required' }
  | { status: 'linked'; identityId: string; userId: string }
  | {
      status: 'signup_required';
      challenge: string;
      expiresAt: Date;
      email: string | null;
      emailVerified: boolean;
      needsEmail: boolean;
      needsDateOfBirth: boolean;
      returnTo: string | null;
    }
  | {
      status: 'signed_in';
      userId: string;
      session: CreatedSession;
      returnTo: string | null;
      created: boolean;
      ageBand?: AgeBand;
    };

export type FinishSocialSignupResult =
  | { status: 'invalid' }
  | { status: 'account_limit' }
  | { status: 'parental_consent_required' }
  | {
      status: 'signed_in';
      userId: string;
      session: CreatedSession;
      returnTo: string | null;
      ageBand: AgeBand;
      method: string;
      verifyEmail: { address: string; locale: string | null } | null;
    };

export async function beginSocial(
  store: OauthStateStore,
  options: {
    social: SocialConfig;
    providerId: string;
    intent: SocialIntent;
    userId: string | null;
    sessionId: string | null;
    returnTo: string | null;
    locale: string | null;
    redirectUri: string;
    realm: string;
    fetch?: typeof fetch;
    now: Date;
  },
): Promise<BeginSocialResult> {
  const provider = findSocialProvider(options.social, options.providerId);
  if (provider === undefined) return { status: 'disabled' };
  const state = newToken();
  const binding = newToken();
  const codeVerifier = provider.usePkce ? pkceVerifier() : null;
  const nonce = provider.useNonce ? newToken() : null;
  const value: OauthState = {
    provider: provider.id,
    intent: options.intent,
    userId: options.intent === 'link' ? options.userId : null,
    sessionId: options.intent === 'link' ? options.sessionId : null,
    bindingHash: hashToken(binding),
    returnTo: options.returnTo,
    locale: options.locale,
    redirectUri: options.redirectUri,
    codeVerifier,
    nonce,
    createdAt: options.now.getTime(),
  };
  await store.put(state, value, OAUTH_STATE_TTL);
  const url = await authorizeUrl(provider, {
    state,
    redirectUri: options.redirectUri,
    realm: options.realm,
    codeVerifier,
    nonce,
    fetch: options.fetch ?? fetch,
  });
  return {
    status: 'ok',
    url,
    binding,
    expiresAt: new Date(options.now.getTime() + OAUTH_STATE_TTL),
  };
}

async function authorizeUrl(
  provider: SocialProvider,
  options: {
    state: string;
    redirectUri: string;
    realm: string;
    codeVerifier: string | null;
    nonce: string | null;
    fetch: typeof fetch;
  },
): Promise<string> {
  if (provider.protocol === 'steam') {
    return steamAuthorizationUrl({
      realm: options.realm,
      returnTo: steamReturnTo(options.redirectUri, options.state),
    });
  }
  const discovery = await discoveryOf(provider, options.fetch);
  return authorizationUrl(provider, {
    discovery,
    redirectUri: options.redirectUri,
    state: options.state,
    codeChallenge: options.codeVerifier === null ? null : pkceChallenge(options.codeVerifier),
    nonce: options.nonce,
  });
}

async function discoveryOf(
  provider: SocialProvider,
  fetchImpl: typeof fetch = fetch,
): Promise<OidcDiscovery | undefined> {
  if (provider.issuer === null || provider.authorizationEndpoint !== null) return undefined;
  return discoverIssuer(provider.issuer, fetchImpl);
}

export async function completeSocial(
  db: Kysely<Database>,
  store: OauthStateStore,
  options: {
    social: SocialConfig;
    providerId: string;
    state: string;
    binding: string | null;
    sessionId: string | null;
    code: string | undefined;
    params: URLSearchParams;
    error: string | undefined;
    client: SessionClient;
    settings: SocialSettings;
    fetch?: typeof fetch;
    now: Date;
  },
): Promise<CompleteSocialResult> {
  if (options.error === 'access_denied') {
    await store.take(options.state);
    return { status: 'denied' };
  }
  const stored = await store.take(options.state);
  if (stored?.provider !== options.providerId) return { status: 'invalid' };
  if (options.binding === null || hashToken(options.binding) !== stored.bindingHash) {
    return { status: 'invalid' };
  }
  const provider = findSocialProvider(options.social, options.providerId);
  if (provider === undefined) return { status: 'invalid' };
  const fetchImpl = options.fetch ?? fetch;

  let profile: SocialProfile;
  try {
    profile = await loadProfile(provider, stored, {
      code: options.code,
      params: options.params,
      fetch: fetchImpl,
    });
  } catch {
    return { status: 'provider_unavailable' };
  }

  if (stored.intent === 'link') {
    if (stored.userId === null || stored.sessionId === null) return { status: 'invalid' };
    if (stored.sessionId !== options.sessionId) return { status: 'invalid' };
    return linkIdentity(db, {
      userId: stored.userId,
      type: provider.type,
      subject: profile.subject,
      now: options.now,
    });
  }

  const existing = await findIdentity(db, provider.type, profile.subject);
  if (existing !== undefined) {
    await touchIdentity(db, existing.id, options.now);
    const session = await createSession(db, {
      userId: existing.user_id,
      authMethod: provider.type,
      amr: socialAmr(provider.type),
      acr: 'aal1',
      client: options.client,
      settings: options.settings.sessions,
      now: options.now,
    });
    return {
      status: 'signed_in',
      userId: existing.user_id,
      session,
      returnTo: stored.returnTo,
      created: false,
    };
  }

  const birthdate =
    profile.birthdate !== null && isValidDateOfBirth(profile.birthdate, options.now)
      ? profile.birthdate
      : null;
  if (profile.email !== null && profile.emailVerified && birthdate !== null) {
    return createSocialAccount(db, {
      type: provider.type,
      subject: profile.subject,
      email: profile.email,
      emailVerified: true,
      dateOfBirth: birthdate,
      locale: stored.locale,
      returnTo: stored.returnTo,
      client: options.client,
      settings: options.settings,
      now: options.now,
    });
  }

  const issued = await insertChallenge(db, {
    kind: SOCIAL_SIGNUP_KIND,
    userId: null,
    payload: {
      provider: provider.id,
      type: provider.type,
      subject: profile.subject,
      email: profile.email,
      emailVerified: profile.emailVerified,
      birthdate,
      locale: stored.locale,
      returnTo: stored.returnTo,
    } satisfies SignupPayload,
    now: options.now,
    ttl: SOCIAL_SIGNUP_TTL,
  });
  return {
    status: 'signup_required',
    challenge: issued.token,
    expiresAt: issued.expiresAt,
    email: profile.email,
    emailVerified: profile.emailVerified,
    needsEmail: profile.email === null,
    needsDateOfBirth: birthdate === null,
    returnTo: stored.returnTo,
  };
}

async function loadProfile(
  provider: SocialProvider,
  stored: OauthState,
  options: { code: string | undefined; params: URLSearchParams; fetch: typeof fetch },
): Promise<SocialProfile> {
  if (provider.protocol === 'steam') {
    const steamId = await verifySteamAssertion(options.params, {
      redirectUri: stored.redirectUri,
      state: options.params.get('state') ?? '',
      fetch: options.fetch,
    });
    if (steamId === undefined) throw new Error('Steam assertion failed');
    return { subject: steamId, email: null, emailVerified: false, name: null, birthdate: null };
  }
  if (options.code === undefined || options.code === '')
    throw new Error('Missing authorization code');
  const discovery = await discoveryOf(provider, options.fetch);
  const tokens = await exchangeAuthorizationCode(provider, {
    code: options.code,
    redirectUri: stored.redirectUri,
    codeVerifier: stored.codeVerifier,
    discovery,
    fetch: options.fetch,
  });
  return loadSocialProfile(provider, tokens, {
    discovery,
    nonce: stored.nonce,
    fetch: options.fetch,
  });
}

async function linkIdentity(
  db: Kysely<Database>,
  options: { userId: string; type: string; subject: string; now: Date },
): Promise<Extract<CompleteSocialResult, { status: 'linked' | 'identity_in_use' | 'invalid' }>> {
  const account = await findAccount(db, options.userId);
  if (!account || account.state === 'deleted') return { status: 'invalid' };
  const bySubject = await findIdentity(db, options.type, options.subject);
  if (bySubject !== undefined) {
    if (bySubject.user_id !== options.userId) return { status: 'identity_in_use' };
    await touchIdentity(db, bySubject.id, options.now);
    return { status: 'linked', identityId: bySubject.id, userId: options.userId };
  }
  const sameType = await db
    .selectFrom('identities')
    .select('id')
    .where('user_id', '=', options.userId)
    .where('type', '=', options.type)
    .executeTakeFirst();
  if (sameType !== undefined) return { status: 'identity_in_use' };
  const id = await insertSocialIdentity(db, options);
  return { status: 'linked', identityId: id, userId: options.userId };
}

export function finishSocialSignup(
  db: Kysely<Database>,
  options: {
    challenge: string;
    dateOfBirth: string | undefined;
    email: string | undefined;
    client: SessionClient;
    settings: SocialSettings;
    now: Date;
  },
): Promise<FinishSocialSignupResult> {
  return db.transaction().execute(async (trx): Promise<FinishSocialSignupResult> => {
    const taken = await takeChallenge(trx, options.challenge, SOCIAL_SIGNUP_KIND, options.now);
    if (taken.status === 'invalid') return { status: 'invalid' };
    const payload = challengePayload(taken.row) as SignupPayload;
    const dateOfBirth = payload.birthdate ?? options.dateOfBirth;
    if (dateOfBirth === undefined || !isValidDateOfBirth(dateOfBirth, options.now)) {
      return { status: 'invalid' };
    }
    const submitted = options.email?.trim();
    const email = submitted !== undefined && submitted !== '' ? submitted : payload.email;
    if (email === null || email === '') return { status: 'invalid' };
    const existing = await findIdentity(trx, payload.type, payload.subject);
    if (existing !== undefined) return { status: 'invalid' };
    const created = await createSocialAccount(trx, {
      type: payload.type,
      subject: payload.subject,
      email,
      emailVerified: payload.emailVerified && payload.email === email,
      dateOfBirth,
      locale: payload.locale,
      returnTo: payload.returnTo,
      client: options.client,
      settings: options.settings,
      now: options.now,
    });
    if (created.status !== 'signed_in') {
      await useChallenge(trx, taken.row.id, options.now);
      return created;
    }
    await useChallenge(trx, taken.row.id, options.now);
    return {
      status: 'signed_in',
      userId: created.userId,
      session: created.session,
      returnTo: created.returnTo,
      ageBand: created.ageBand ?? ageBand(ageOn(dateOfBirth, options.now), options.settings.bands),
      method: payload.type,
      verifyEmail:
        payload.emailVerified && payload.email === email
          ? null
          : { address: email.trim(), locale: payload.locale },
    };
  });
}

async function createSocialAccount(
  db: Kysely<Database>,
  options: {
    type: string;
    subject: string;
    email: string;
    emailVerified: boolean;
    dateOfBirth: string;
    locale: string | null;
    returnTo: string | null;
    client: SessionClient;
    settings: SocialSettings;
    now: Date;
  },
): Promise<
  Extract<
    CompleteSocialResult,
    { status: 'signed_in' | 'account_limit' | 'parental_consent_required' }
  >
> {
  const { settings, now } = options;
  const emailNormalized = settings.normalizeEmail(options.email);
  const age = ageOn(options.dateOfBirth, now);
  const state = initialAccountState({
    emailVerified: options.emailVerified,
    age,
    consentAge: settings.consentAge,
  });
  if (state === 'pending_parental_consent') return { status: 'parental_consent_required' };

  return db.transaction().execute(async (trx) => {
    const taken = await findIdentity(trx, options.type, options.subject);
    if (taken !== undefined) {
      await touchIdentity(trx, taken.id, now);
      const session = await createSession(trx, {
        userId: taken.user_id,
        authMethod: options.type,
        amr: socialAmr(options.type),
        acr: 'aal1',
        client: options.client,
        settings: settings.sessions,
        now,
      });
      return {
        status: 'signed_in' as const,
        userId: taken.user_id,
        session,
        returnTo: options.returnTo,
        created: false,
      };
    }
    await lockEmail(trx, emailNormalized);
    const existing = await accountsWithEmail(trx, emailNormalized);
    if (existing.length >= settings.maxPerEmail) return { status: 'account_limit' as const };
    const privacy = agePrivacyDefaults(under18(age, settings.bands));
    const userId = await createUser(trx, {
      state,
      email: options.email.trim(),
      emailNormalized,
      emailVerifiedAt: options.emailVerified ? now : null,
      dateOfBirth: options.dateOfBirth,
      locale: options.locale,
      ...privacy,
    });
    await insertSocialIdentity(trx, {
      userId,
      type: options.type,
      subject: options.subject,
      now,
    });
    const band = ageBand(age, settings.bands);
    await recordSignupAgeAssurance(trx, {
      userId,
      adult: band === 'adult',
      defaultProvider: settings.defaultProvider,
      requiredFor: settings.requiredFor,
      now,
    });
    await writeEvent<Database, UserCreatedData>(
      trx,
      userCreatedEvent(userId, {
        signup_method: options.type,
        account_state: state,
        age_band: band,
      }),
    );
    const session = await createSession(trx, {
      userId,
      authMethod: options.type,
      amr: socialAmr(options.type),
      acr: 'aal1',
      client: options.client,
      settings: settings.sessions,
      now,
    });
    return {
      status: 'signed_in' as const,
      userId,
      session,
      returnTo: options.returnTo,
      created: true,
      ageBand: band,
    };
  });
}

function findIdentity(
  db: Kysely<Database>,
  type: string,
  subject: string,
): Promise<{ id: string; user_id: string } | undefined> {
  return db
    .selectFrom('identities')
    .select(['id', 'user_id'])
    .where('type', '=', type)
    .where('subject', '=', subject)
    .executeTakeFirst();
}

async function insertSocialIdentity(
  db: Kysely<Database>,
  options: { userId: string; type: string; subject: string; now: Date },
): Promise<string> {
  const id = randomUUIDv7();
  await db
    .insertInto('identities')
    .values({
      id,
      user_id: options.userId,
      type: options.type,
      subject: options.subject,
      secret: null,
      last_used_at: options.now,
    })
    .execute();
  return id;
}

async function touchIdentity(db: Kysely<Database>, id: string, now: Date): Promise<void> {
  await db.updateTable('identities').set({ last_used_at: now }).where('id', '=', id).execute();
}

/**
 * A connected upstream identity: it has a provider subject, and is not one of
 * the passkeys that share the identities table.
 */
function isSocial(eb: ExpressionBuilder<Database, 'identities'>): Expression<SqlBool> {
  return eb.and([eb('subject', 'is not', null), eb('type', 'not in', [PASSKEY_METHOD])]);
}

export function listSocialIdentities(
  db: Kysely<Database>,
  userId: string,
): Promise<SocialIdentity[]> {
  return db
    .selectFrom('identities')
    .select(['id', 'type', 'created_at', 'last_used_at'])
    .where('user_id', '=', userId)
    .where(isSocial)
    .orderBy('created_at')
    .orderBy('id')
    .execute()
    .then((rows) =>
      rows.map((row) => ({
        id: row.id,
        type: row.type,
        createdAt: row.created_at,
        lastUsedAt: row.last_used_at,
      })),
    );
}

export async function socialIdentityCount(db: Kysely<Database>, userId: string): Promise<number> {
  const row = await db
    .selectFrom('identities')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('user_id', '=', userId)
    .where(isSocial)
    .executeTakeFirst();
  return Number(row?.count ?? 0);
}

export async function deleteSocialIdentity(
  db: Kysely<Database>,
  options: { id: string; userId: string },
): Promise<boolean> {
  const result = await db
    .deleteFrom('identities')
    .where('id', '=', options.id)
    .where('user_id', '=', options.userId)
    .where(isSocial)
    .executeTakeFirst();
  return Number(result.numDeletedRows) === 1;
}

export async function findSocialIdentity(
  db: Kysely<Database>,
  options: { id: string; userId: string },
): Promise<SocialIdentity | undefined> {
  const row = await db
    .selectFrom('identities')
    .select(['id', 'type', 'created_at', 'last_used_at'])
    .where('id', '=', options.id)
    .where('user_id', '=', options.userId)
    .where(isSocial)
    .executeTakeFirst();
  if (row === undefined) return undefined;
  return { id: row.id, type: row.type, createdAt: row.created_at, lastUsedAt: row.last_used_at };
}
