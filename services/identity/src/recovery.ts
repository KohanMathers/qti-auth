import { randomBytes, randomUUIDv7 } from 'node:crypto';

import type { Kysely } from 'kysely';

import type { Database } from './database.ts';
import { hashToken } from './tokens.ts';

export const RECOVERY_AMR = ['otp'];
export const RECOVERY_CODE_COUNT = 10;
export const RECOVERY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function randomCode(): string {
  const bytes = randomBytes(10);
  let value = '';
  for (const byte of bytes) value += RECOVERY_ALPHABET[byte & 31] ?? '';
  return `${value.slice(0, 5)}-${value.slice(5)}`;
}

export function normalizeRecoveryCode(code: string): string | undefined {
  const cleaned = code.trim().toUpperCase().replace(/[-\s]/g, '');
  if (cleaned.length !== 10) return undefined;
  for (const char of cleaned) {
    if (!RECOVERY_ALPHABET.includes(char)) return undefined;
  }
  return `${cleaned.slice(0, 5)}-${cleaned.slice(5)}`;
}

export function generateRecoveryCodes(): string[] {
  const codes = new Set<string>();
  while (codes.size < RECOVERY_CODE_COUNT) codes.add(randomCode());
  return [...codes];
}

export async function replaceRecoveryCodes(
  db: Kysely<Database>,
  userId: string,
  now: Date,
): Promise<string[]> {
  const codes = generateRecoveryCodes();
  await db.deleteFrom('recovery_codes').where('user_id', '=', userId).execute();
  if (codes.length === 0) return codes;
  await db
    .insertInto('recovery_codes')
    .values(
      codes.map((code) => ({
        id: randomUUIDv7(),
        user_id: userId,
        code_hash: hashToken(code),
        created_at: now,
      })),
    )
    .execute();
  return codes;
}

export async function unusedRecoveryCount(db: Kysely<Database>, userId: string): Promise<number> {
  const row = await db
    .selectFrom('recovery_codes')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('user_id', '=', userId)
    .where('used_at', 'is', null)
    .executeTakeFirst();
  return Number(row?.count ?? 0);
}

export async function consumeRecoveryCode(
  db: Kysely<Database>,
  options: { userId: string; code: string; now: Date },
): Promise<boolean> {
  const normalized = normalizeRecoveryCode(options.code);
  if (normalized === undefined) return false;
  const row = await db
    .selectFrom('recovery_codes')
    .select('id')
    .where('user_id', '=', options.userId)
    .where('code_hash', '=', hashToken(normalized))
    .where('used_at', 'is', null)
    .executeTakeFirst();
  if (!row) return false;
  const result = await db
    .updateTable('recovery_codes')
    .set({ used_at: options.now })
    .where('id', '=', row.id)
    .where('used_at', 'is', null)
    .executeTakeFirst();
  return Number(result.numUpdatedRows) === 1;
}
