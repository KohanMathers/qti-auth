import { randomUUIDv7 } from 'node:crypto';

import { writeEvent } from '@qtiauth/bus';
import { deletedRows } from '@qtiauth/db';
import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type { Kysely } from 'kysely';

import type { Database } from './database.ts';
import { type AuditRecordedData, auditRecordedEvent } from './events.ts';

export const PASSKEY_METHOD = 'passkey';
export const PASSKEY_AMR = ['webauthn'];
export const PASSKEY_NAME_MAX = 64;

export interface RelyingParty {
  name: string;
  rpID: string;
  origins: string[];
}

export interface StoredPasskey {
  id: string;
  userId: string;
  name: string;
  credentialId: string;
  publicKey: string;
  counter: number;
  transports: string[];
  createdAt: Date;
  lastUsedAt: Date | null;
}

export interface PasskeySecret {
  name: string;
  publicKey: string;
  counter: number;
  transports: string[];
}

export function uuidBytes(id: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.from(id.replaceAll('-', ''), 'hex'));
}

function encodePublicKey(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function decodePublicKey(value: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.from(value, 'base64url'));
}

export function parsePasskeySecret(secret: string | null): PasskeySecret | undefined {
  if (secret === null) return undefined;
  try {
    const parsed = JSON.parse(secret) as Partial<PasskeySecret>;
    if (
      typeof parsed.name !== 'string' ||
      typeof parsed.publicKey !== 'string' ||
      typeof parsed.counter !== 'number' ||
      !Array.isArray(parsed.transports)
    ) {
      return undefined;
    }
    return {
      name: parsed.name,
      publicKey: parsed.publicKey,
      counter: parsed.counter,
      transports: parsed.transports.filter((item): item is string => typeof item === 'string'),
    };
  } catch {
    return undefined;
  }
}

export async function passkeyRegistrationOptions(options: {
  rp: RelyingParty;
  userId: string;
  userName: string;
  exclude: { id: string; transports?: string[] }[];
}): Promise<PublicKeyCredentialCreationOptionsJSON> {
  return generateRegistrationOptions({
    rpName: options.rp.name,
    rpID: options.rp.rpID,
    userID: uuidBytes(options.userId),
    userName: options.userName,
    userDisplayName: options.userName,
    attestationType: 'none',
    excludeCredentials: options.exclude.map((credential) => ({
      id: credential.id,
      transports: (credential.transports ?? []) as 'internal'[],
    })),
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
  });
}

export async function passkeyAuthenticationOptions(options: {
  rp: RelyingParty;
  allow?: { id: string; transports?: string[] | undefined }[] | undefined;
}): Promise<PublicKeyCredentialRequestOptionsJSON> {
  return generateAuthenticationOptions({
    rpID: options.rp.rpID,
    userVerification: 'preferred',
    ...(options.allow === undefined
      ? {}
      : {
          allowCredentials: options.allow.map((credential) => ({
            id: credential.id,
            transports: (credential.transports ?? []) as 'internal'[],
          })),
        }),
  });
}

export async function verifyPasskeyRegistration(options: {
  rp: RelyingParty;
  challenge: string;
  response: RegistrationResponseJSON;
}): Promise<
  { credentialId: string; publicKey: string; counter: number; transports: string[] } | undefined
> {
  const result = await verifyRegistrationResponse({
    response: options.response,
    expectedChallenge: options.challenge,
    expectedOrigin: options.rp.origins,
    expectedRPID: options.rp.rpID,
    requireUserVerification: false,
  });
  if (!result.verified) return undefined;
  const { credential } = result.registrationInfo;
  return {
    credentialId: credential.id,
    publicKey: encodePublicKey(credential.publicKey),
    counter: credential.counter,
    transports: credential.transports ?? [],
  };
}

export async function verifyPasskeyAuthentication(options: {
  rp: RelyingParty;
  challenge: string;
  response: AuthenticationResponseJSON;
  credential: { id: string; publicKey: string; counter: number; transports: string[] };
}): Promise<{ newCounter: number } | undefined> {
  const result = await verifyAuthenticationResponse({
    response: options.response,
    expectedChallenge: options.challenge,
    expectedOrigin: options.rp.origins,
    expectedRPID: options.rp.rpID,
    requireUserVerification: false,
    credential: {
      id: options.credential.id,
      publicKey: decodePublicKey(options.credential.publicKey),
      counter: options.credential.counter,
      transports: options.credential.transports as 'internal'[],
    },
  });
  if (!result.verified) return undefined;
  return { newCounter: result.authenticationInfo.newCounter };
}

export function listPasskeys(db: Kysely<Database>, userId: string): Promise<StoredPasskey[]> {
  return db
    .selectFrom('identities')
    .select(['id', 'subject', 'secret', 'created_at', 'last_used_at'])
    .where('user_id', '=', userId)
    .where('type', '=', PASSKEY_METHOD)
    .where('subject', 'is not', null)
    .orderBy('created_at')
    .orderBy('id')
    .execute()
    .then((rows) =>
      rows.flatMap((row) => {
        if (row.subject === null) return [];
        const secret = parsePasskeySecret(row.secret);
        if (!secret) return [];
        return [
          {
            id: row.id,
            userId,
            name: secret.name,
            credentialId: row.subject,
            publicKey: secret.publicKey,
            counter: secret.counter,
            transports: secret.transports,
            createdAt: row.created_at,
            lastUsedAt: row.last_used_at,
          },
        ];
      }),
    );
}

export async function findPasskeyByCredential(
  db: Kysely<Database>,
  credentialId: string,
): Promise<StoredPasskey | undefined> {
  const row = await db
    .selectFrom('identities')
    .select(['id', 'user_id', 'subject', 'secret', 'created_at', 'last_used_at'])
    .where('type', '=', PASSKEY_METHOD)
    .where('subject', '=', credentialId)
    .executeTakeFirst();
  if (row?.subject == null) return undefined;
  const secret = parsePasskeySecret(row.secret);
  if (!secret) return undefined;
  return {
    id: row.id,
    userId: row.user_id,
    name: secret.name,
    credentialId: row.subject,
    publicKey: secret.publicKey,
    counter: secret.counter,
    transports: secret.transports,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

export async function insertPasskey(
  db: Kysely<Database>,
  options: {
    userId: string;
    name: string;
    credentialId: string;
    publicKey: string;
    counter: number;
    transports: string[];
    now: Date;
  },
): Promise<string> {
  const id = randomUUIDv7();
  await db
    .insertInto('identities')
    .values({
      id,
      user_id: options.userId,
      type: PASSKEY_METHOD,
      subject: options.credentialId,
      secret: JSON.stringify({
        name: options.name,
        publicKey: options.publicKey,
        counter: options.counter,
        transports: options.transports,
      } satisfies PasskeySecret),
      last_used_at: options.now,
    })
    .execute();
  return id;
}

export async function touchPasskey(
  db: Kysely<Database>,
  options: { id: string; counter: number; now: Date },
): Promise<void> {
  const row = await db
    .selectFrom('identities')
    .select('secret')
    .where('id', '=', options.id)
    .executeTakeFirst();
  const secret = parsePasskeySecret(row?.secret ?? null);
  if (!secret) return;
  await db
    .updateTable('identities')
    .set({
      secret: JSON.stringify({ ...secret, counter: options.counter } satisfies PasskeySecret),
      last_used_at: options.now,
    })
    .where('id', '=', options.id)
    .execute();
}

export async function renamePasskey(
  db: Kysely<Database>,
  options: { id: string; userId: string; name: string },
): Promise<boolean> {
  const row = await db
    .selectFrom('identities')
    .select(['id', 'secret'])
    .where('id', '=', options.id)
    .where('user_id', '=', options.userId)
    .where('type', '=', PASSKEY_METHOD)
    .executeTakeFirst();
  const secret = parsePasskeySecret(row?.secret ?? null);
  if (!row || !secret) return false;
  await db
    .updateTable('identities')
    .set({ secret: JSON.stringify({ ...secret, name: options.name } satisfies PasskeySecret) })
    .where('id', '=', row.id)
    .execute();
  return true;
}

export async function deletePasskey(
  db: Kysely<Database>,
  options: { id: string; userId: string },
): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    const result = await trx
      .deleteFrom('identities')
      .where('id', '=', options.id)
      .where('user_id', '=', options.userId)
      .where('type', '=', PASSKEY_METHOD)
      .executeTakeFirst();
    if (deletedRows(result) !== 1) return false;
    await writeEvent<Database, AuditRecordedData>(
      trx,
      auditRecordedEvent(
        { type: 'user', id: options.userId },
        { action: 'user.passkey.removed', target_type: 'user', target_id: options.userId },
      ),
    );
    return true;
  });
}

export async function passkeyCount(db: Kysely<Database>, userId: string): Promise<number> {
  const row = await db
    .selectFrom('identities')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('user_id', '=', userId)
    .where('type', '=', PASSKEY_METHOD)
    .executeTakeFirst();
  return Number(row?.count ?? 0);
}
