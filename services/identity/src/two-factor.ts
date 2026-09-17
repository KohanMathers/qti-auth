import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import type { Kysely } from 'kysely';

import { recordIdentityUse } from './accounts.ts';
import { challengePayload, insertChallenge, takeChallenge, useChallenge } from './challenges.ts';
import type { Database } from './database.ts';
import {
  deleteTotp,
  findTotpIdentity,
  openTotpSecret,
  saveTotpSecret,
  type SecondFactorMethod,
  totpEnrolled,
} from './factors.ts';
import {
  findPasskeyByCredential,
  insertPasskey,
  listPasskeys,
  PASSKEY_AMR,
  PASSKEY_METHOD,
  passkeyAuthenticationOptions,
  passkeyRegistrationOptions,
  type RelyingParty,
  touchPasskey,
  verifyPasskeyAuthentication,
  verifyPasskeyRegistration,
} from './passkeys.ts';
import { consumeRecoveryCode, replaceRecoveryCodes, RECOVERY_AMR } from './recovery.ts';
import {
  type CreatedSession,
  createSession,
  type SessionClient,
  type SessionSettings,
  upgradeSession,
} from './sessions.ts';
import {
  encodeBase32,
  otpauthUri,
  randomTotpSecret,
  TOTP_AMR,
  TOTP_METHOD,
  verifyTotp,
} from './totp.ts';

interface SecondFactorPayload {
  methods: SecondFactorMethod[];
  amr: string[];
  authMethod: string;
}

export async function beginTotpEnrol(
  db: Kysely<Database>,
  options: { userId: string; email: string; issuer: string; now: Date },
): Promise<
  | { status: 'already_enabled' }
  | { status: 'started'; challenge: string; otpauth: string; secret: string; expiresAt: Date }
> {
  if (await totpEnrolled(db, options.userId)) return { status: 'already_enabled' };
  const secret = randomTotpSecret();
  const { token, expiresAt } = await insertChallenge(db, {
    kind: 'totp_enrol',
    userId: options.userId,
    payload: { secret: secret.toString('base64url') },
    now: options.now,
  });
  return {
    status: 'started',
    challenge: token,
    otpauth: otpauthUri({ issuer: options.issuer, account: options.email, secret }),
    secret: encodeBase32(secret),
    expiresAt,
  };
}

export async function confirmTotpEnrol(
  db: Kysely<Database>,
  options: { userId: string; challenge: string; code: string; key: Buffer; now: Date },
): Promise<
  | { status: 'invalid' }
  | { status: 'wrong_code' }
  | { status: 'already_enabled' }
  | { status: 'enabled'; recoveryCodes: string[] }
> {
  return db.transaction().execute(async (trx) => {
    if (await totpEnrolled(trx, options.userId)) return { status: 'already_enabled' as const };
    const taken = await takeChallenge(trx, options.challenge, 'totp_enrol', options.now);
    if (taken.status === 'invalid' || taken.row.user_id !== options.userId) {
      return { status: 'invalid' as const };
    }
    const payload = challengePayload(taken.row) as { secret: string };
    const secret = Buffer.from(payload.secret, 'base64url');
    if (!verifyTotp(secret, options.code, options.now)) return { status: 'wrong_code' as const };
    await useChallenge(trx, taken.row.id, options.now);
    await saveTotpSecret(trx, {
      userId: options.userId,
      secret,
      key: options.key,
      now: options.now,
    });
    return {
      status: 'enabled' as const,
      recoveryCodes: await replaceRecoveryCodes(trx, options.userId, options.now),
    };
  });
}

export type DisableTotpResult =
  { status: 'not_enabled' } | { status: 'wrong_code' } | { status: 'disabled' };

export async function disableTotp(
  db: Kysely<Database>,
  options: { userId: string; code: string; key: Buffer; now: Date },
): Promise<DisableTotpResult> {
  const identity = await findTotpIdentity(db, options.userId);
  if (identity?.secret === undefined || identity.secret === null) {
    return { status: 'not_enabled' };
  }
  if (
    !verifyTotp(
      openTotpSecret(identity.secret, options.key, options.userId),
      options.code,
      options.now,
    )
  ) {
    return { status: 'wrong_code' };
  }
  await deleteTotp(db, options.userId);
  return { status: 'disabled' };
}

export async function completeSecondFactor(
  db: Kysely<Database>,
  options: {
    challenge: string;
    totp?: string | undefined;
    recoveryCode?: string | undefined;
    key: Buffer;
    client: SessionClient;
    sessions: SessionSettings;
    now: Date;
  },
): Promise<
  | { status: 'invalid' }
  | { status: 'wrong_code' }
  | {
      status: 'signed_in';
      userId: string;
      session: CreatedSession;
      method: SecondFactorMethod;
      authMethod: string;
    }
> {
  return db.transaction().execute(async (trx) => {
    const taken = await takeChallenge(trx, options.challenge, 'second_factor', options.now);
    if (taken.status === 'invalid' || taken.row.user_id === null)
      return { status: 'invalid' as const };
    const userId = taken.row.user_id;
    const payload = challengePayload(taken.row) as SecondFactorPayload;
    let method: SecondFactorMethod;
    let amr = payload.amr;

    if (options.totp !== undefined) {
      const identity = await findTotpIdentity(trx, userId);
      if (identity?.secret === undefined || identity.secret === null) {
        return { status: 'invalid' as const };
      }
      if (
        !verifyTotp(openTotpSecret(identity.secret, options.key, userId), options.totp, options.now)
      ) {
        return { status: 'wrong_code' as const };
      }
      await recordIdentityUse(trx, userId, TOTP_METHOD, options.now);
      method = 'totp';
      amr = [...amr, ...TOTP_AMR];
    } else if (options.recoveryCode !== undefined) {
      if (
        !(await consumeRecoveryCode(trx, { userId, code: options.recoveryCode, now: options.now }))
      ) {
        return { status: 'wrong_code' as const };
      }
      method = 'recovery';
      amr = [...amr, ...RECOVERY_AMR];
    } else {
      return { status: 'invalid' as const };
    }

    await useChallenge(trx, taken.row.id, options.now);
    const session = await createSession(trx, {
      userId,
      authMethod: payload.authMethod,
      amr,
      acr: 'aal2',
      client: options.client,
      settings: options.sessions,
      now: options.now,
    });
    return {
      status: 'signed_in' as const,
      userId,
      session,
      method,
      authMethod: payload.authMethod,
    };
  });
}

export type StepUpResult =
  | { status: 'not_found' }
  // Covers a wrong code, a code for a factor that is not enrolled, and no code
  // at all: the caller must not learn which from the answer.
  | { status: 'wrong_code' }
  | { status: 'upgraded' };

export async function stepUpSession(
  db: Kysely<Database>,
  options: {
    userId: string;
    sessionId: string;
    totp?: string | undefined;
    recoveryCode?: string | undefined;
    key: Buffer;
    now: Date;
  },
): Promise<StepUpResult> {
  let amr: string[];
  if (options.totp !== undefined) {
    const identity = await findTotpIdentity(db, options.userId);
    if (identity?.secret === undefined || identity.secret === null) {
      return { status: 'wrong_code' };
    }
    if (
      !verifyTotp(
        openTotpSecret(identity.secret, options.key, options.userId),
        options.totp,
        options.now,
      )
    ) {
      return { status: 'wrong_code' };
    }
    amr = TOTP_AMR;
    await recordIdentityUse(db, options.userId, TOTP_METHOD, options.now);
  } else if (options.recoveryCode !== undefined) {
    if (
      !(await consumeRecoveryCode(db, {
        userId: options.userId,
        code: options.recoveryCode,
        now: options.now,
      }))
    ) {
      return { status: 'wrong_code' };
    }
    amr = RECOVERY_AMR;
  } else {
    return { status: 'wrong_code' };
  }
  const upgraded = await upgradeSession(db, {
    sessionId: options.sessionId,
    userId: options.userId,
    amr,
    now: options.now,
  });
  return upgraded ? { status: 'upgraded' } : { status: 'not_found' };
}

export async function beginPasskeyRegister(
  db: Kysely<Database>,
  options: { userId: string; userName: string; rp: RelyingParty; now: Date },
): Promise<{
  challenge: string;
  options: Awaited<ReturnType<typeof passkeyRegistrationOptions>>;
  expiresAt: Date;
}> {
  const existing = await listPasskeys(db, options.userId);
  const webauthn = await passkeyRegistrationOptions({
    rp: options.rp,
    userId: options.userId,
    userName: options.userName,
    exclude: existing.map((passkey) => ({
      id: passkey.credentialId,
      transports: passkey.transports,
    })),
  });
  const { token, expiresAt } = await insertChallenge(db, {
    kind: 'passkey_register',
    userId: options.userId,
    payload: { challenge: webauthn.challenge },
    now: options.now,
  });
  return { challenge: token, options: webauthn, expiresAt };
}

export async function completePasskeyRegister(
  db: Kysely<Database>,
  options: {
    userId: string;
    challenge: string;
    name: string;
    response: RegistrationResponseJSON;
    rp: RelyingParty;
    now: Date;
  },
): Promise<{ status: 'invalid' } | { status: 'registered'; id: string }> {
  return db.transaction().execute(async (trx) => {
    const taken = await takeChallenge(trx, options.challenge, 'passkey_register', options.now);
    if (taken.status === 'invalid' || taken.row.user_id !== options.userId) {
      return { status: 'invalid' as const };
    }
    const payload = challengePayload(taken.row) as { challenge: string };
    const verified = await verifyPasskeyRegistration({
      rp: options.rp,
      challenge: payload.challenge,
      response: options.response,
    });
    if (!verified) return { status: 'invalid' as const };
    await useChallenge(trx, taken.row.id, options.now);
    const id = await insertPasskey(trx, {
      userId: options.userId,
      name: options.name,
      credentialId: verified.credentialId,
      publicKey: verified.publicKey,
      counter: verified.counter,
      transports: verified.transports,
      now: options.now,
    });
    return { status: 'registered' as const, id };
  });
}

export async function beginPasskeyAuthenticate(
  db: Kysely<Database>,
  options: {
    rp: RelyingParty;
    userId?: string | undefined;
    secondFactorChallenge?: string | undefined;
    now: Date;
  },
): Promise<
  | { status: 'invalid' }
  | {
      status: 'ok';
      challenge: string;
      options: Awaited<ReturnType<typeof passkeyAuthenticationOptions>>;
      expiresAt: Date;
    }
> {
  let allow: { id: string; transports?: string[] | undefined }[] | undefined;
  let userId = options.userId ?? null;
  if (options.secondFactorChallenge !== undefined) {
    const taken = await takeChallenge(
      db,
      options.secondFactorChallenge,
      'second_factor',
      options.now,
    );
    if (taken.status === 'invalid' || taken.row.user_id === null) return { status: 'invalid' };
    userId = taken.row.user_id;
    allow = (await listPasskeys(db, userId)).map((passkey) => ({
      id: passkey.credentialId,
      transports: passkey.transports,
    }));
  } else if (userId !== null) {
    allow = (await listPasskeys(db, userId)).map((passkey) => ({
      id: passkey.credentialId,
      transports: passkey.transports,
    }));
  }
  if (allow?.length === 0) return { status: 'invalid' };
  const webauthn = await passkeyAuthenticationOptions({
    rp: options.rp,
    ...(allow === undefined ? {} : { allow }),
  });
  const { token, expiresAt } = await insertChallenge(db, {
    kind: 'passkey_authenticate',
    userId,
    payload: { challenge: webauthn.challenge, secondFactor: options.secondFactorChallenge ?? null },
    now: options.now,
  });
  return { status: 'ok', challenge: token, options: webauthn, expiresAt };
}

export async function completePasskeyAuthenticate(
  db: Kysely<Database>,
  options: {
    challenge: string;
    response: AuthenticationResponseJSON;
    rp: RelyingParty;
    client: SessionClient;
    sessions: SessionSettings;
    now: Date;
    sessionId?: string | undefined;
  },
): Promise<
  | { status: 'invalid' }
  | {
      status: 'signed_in';
      userId: string;
      session: CreatedSession;
      secondFactor: boolean;
      authMethod: string;
    }
  | { status: 'stepped_up' }
> {
  return db.transaction().execute(async (trx) => {
    const taken = await takeChallenge(trx, options.challenge, 'passkey_authenticate', options.now);
    if (taken.status === 'invalid') return { status: 'invalid' as const };
    const payload = challengePayload(taken.row) as {
      challenge: string;
      secondFactor: string | null;
    };
    const stored = await findPasskeyByCredential(trx, options.response.id);
    if (!stored) return { status: 'invalid' as const };
    if (taken.row.user_id !== null && taken.row.user_id !== stored.userId) {
      return { status: 'invalid' as const };
    }
    const verified = await verifyPasskeyAuthentication({
      rp: options.rp,
      challenge: payload.challenge,
      response: options.response,
      credential: stored,
    });
    if (!verified) return { status: 'invalid' as const };
    await useChallenge(trx, taken.row.id, options.now);
    await touchPasskey(trx, { id: stored.id, counter: verified.newCounter, now: options.now });

    if (options.sessionId !== undefined) {
      const upgraded = await upgradeSession(trx, {
        sessionId: options.sessionId,
        userId: stored.userId,
        amr: PASSKEY_AMR,
        now: options.now,
      });
      return upgraded ? { status: 'stepped_up' as const } : { status: 'invalid' as const };
    }

    if (payload.secondFactor !== null) {
      const factor = await takeChallenge(trx, payload.secondFactor, 'second_factor', options.now);
      if (factor.status === 'invalid' || factor.row.user_id !== stored.userId) {
        return { status: 'invalid' as const };
      }
      const second = challengePayload(factor.row) as SecondFactorPayload;
      await useChallenge(trx, factor.row.id, options.now);
      const session = await createSession(trx, {
        userId: stored.userId,
        authMethod: second.authMethod,
        amr: [...second.amr, ...PASSKEY_AMR],
        acr: 'aal2',
        client: options.client,
        settings: options.sessions,
        now: options.now,
      });
      return {
        status: 'signed_in' as const,
        userId: stored.userId,
        session,
        secondFactor: true,
        authMethod: second.authMethod,
      };
    }

    const session = await createSession(trx, {
      userId: stored.userId,
      authMethod: PASSKEY_METHOD,
      amr: PASSKEY_AMR,
      acr: 'aal2',
      client: options.client,
      settings: options.sessions,
      now: options.now,
    });
    return {
      status: 'signed_in' as const,
      userId: stored.userId,
      session,
      secondFactor: false,
      authMethod: PASSKEY_METHOD,
    };
  });
}
