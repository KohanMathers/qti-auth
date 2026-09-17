import { randomUUIDv7 } from 'node:crypto';

import { ProblemError } from '@qtiauth/service-kit';
import type { Kysely } from 'kysely';

import type { Database } from './database.ts';
import { decryptSecret, encryptSecret } from './encrypt.ts';
import { MAGIC_LINK_METHOD } from './magic-links.ts';
import { PASSKEY_METHOD, passkeyCount } from './passkeys.ts';
import { PASSWORD_METHOD } from './passwords.ts';
import { unusedRecoveryCount } from './recovery.ts';
import { socialIdentityCount } from './social.ts';
import { TOTP_METHOD } from './totp.ts';

export const SECOND_FACTOR_METHODS = ['totp', 'passkey', 'recovery'] as const;
export type SecondFactorMethod = (typeof SECOND_FACTOR_METHODS)[number];

export function permissionNeeds2fa(permission: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    if (pattern === '*' || pattern === permission) return true;
    return pattern.endsWith('.*') && permission.startsWith(pattern.slice(0, -1));
  });
}

export function staffNeeds2fa(
  permissions: readonly string[],
  patterns: readonly string[],
): boolean {
  return permissions.some((permission) => permissionNeeds2fa(permission, patterns));
}

export async function loadPermissions(db: Kysely<Database>, userId: string): Promise<string[]> {
  const rows = await db
    .selectFrom('user_permissions')
    .select('permission')
    .where('user_id', '=', userId)
    .orderBy('permission')
    .execute();
  return rows.map((row) => row.permission);
}

export function findTotpIdentity(
  db: Kysely<Database>,
  userId: string,
): Promise<{ id: string; secret: string | null; last_used_at: Date | null } | undefined> {
  return db
    .selectFrom('identities')
    .select(['id', 'secret', 'last_used_at'])
    .where('user_id', '=', userId)
    .where('type', '=', TOTP_METHOD)
    .where('subject', 'is', null)
    .executeTakeFirst();
}

export async function totpEnrolled(db: Kysely<Database>, userId: string): Promise<boolean> {
  const row = await findTotpIdentity(db, userId);
  return row?.secret !== undefined && row.secret !== null;
}

export async function hasSecondFactor(db: Kysely<Database>, userId: string): Promise<boolean> {
  if (await totpEnrolled(db, userId)) return true;
  return (await passkeyCount(db, userId)) > 0;
}

export async function twoFactorEnrolmentRequired(
  db: Kysely<Database>,
  options: { userId: string; permissions: readonly string[]; patterns: readonly string[] },
): Promise<boolean> {
  if (!staffNeeds2fa(options.permissions, options.patterns)) return false;
  return !(await hasSecondFactor(db, options.userId));
}

export async function secondFactorMethods(
  db: Kysely<Database>,
  userId: string,
): Promise<SecondFactorMethod[]> {
  const methods: SecondFactorMethod[] = [];
  if (await totpEnrolled(db, userId)) methods.push('totp');
  if ((await unusedRecoveryCount(db, userId)) > 0) methods.push('recovery');
  if ((await passkeyCount(db, userId)) > 0) methods.push('passkey');
  return methods;
}

export async function saveTotpSecret(
  db: Kysely<Database>,
  options: { userId: string; secret: Buffer; key: Buffer; now: Date },
): Promise<void> {
  const sealed = encryptSecret(options.secret, options.key, options.userId);
  await db
    .insertInto('identities')
    .values({
      id: randomUUIDv7(),
      user_id: options.userId,
      type: TOTP_METHOD,
      subject: null,
      secret: sealed,
      last_used_at: options.now,
    })
    .onConflict((conflict) =>
      conflict
        .columns(['user_id', 'type'])
        .where('subject', 'is', null)
        .doUpdateSet({ secret: sealed, last_used_at: options.now }),
    )
    .execute();
}

export function openTotpSecret(sealed: string, key: Buffer, userId: string): Buffer {
  return decryptSecret(sealed, key, userId);
}

export async function deleteTotp(db: Kysely<Database>, userId: string): Promise<boolean> {
  const result = await db
    .deleteFrom('identities')
    .where('user_id', '=', userId)
    .where('type', '=', TOTP_METHOD)
    .executeTakeFirst();
  await db.deleteFrom('recovery_codes').where('user_id', '=', userId).execute();
  return Number(result.numDeletedRows) === 1;
}

export async function passwordCount(db: Kysely<Database>, userId: string): Promise<number> {
  const row = await db
    .selectFrom('identities')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('user_id', '=', userId)
    .where('type', '=', PASSWORD_METHOD)
    .where('secret', 'is not', null)
    .executeTakeFirst();
  return Number(row?.count ?? 0);
}

export async function canRemovePasskey(
  db: Kysely<Database>,
  options: { userId: string; magicLinkEnabled: boolean },
): Promise<boolean> {
  return canRemovePrimaryMethod(db, options);
}

export async function primarySignInMethodCount(
  db: Kysely<Database>,
  options: { userId: string; magicLinkEnabled: boolean },
): Promise<number> {
  let count = 0;
  if (options.magicLinkEnabled) count += 1;
  count += await passwordCount(db, options.userId);
  count += await passkeyCount(db, options.userId);
  count += await socialIdentityCount(db, options.userId);
  return count;
}

export async function canRemovePrimaryMethod(
  db: Kysely<Database>,
  options: { userId: string; magicLinkEnabled: boolean },
): Promise<boolean> {
  return (await primarySignInMethodCount(db, options)) > 1;
}

export const DELETE_ACCOUNT_PATH = '/account/delete';

export const LAST_SIGN_IN_METHOD_DETAIL =
  'This is your last available sign-in method. Either add another to remove this one or, if you are attempting to delete your account, go to Delete account.';

export function lastSignInMethodError(): ProblemError {
  return new ProblemError('LAST_SIGN_IN_METHOD', {
    detail: LAST_SIGN_IN_METHOD_DETAIL,
    extensions: { delete_account_path: DELETE_ACCOUNT_PATH },
  });
}

export const PRIMARY_METHODS = [PASSWORD_METHOD, PASSKEY_METHOD, MAGIC_LINK_METHOD] as const;
