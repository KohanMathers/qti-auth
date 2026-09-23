import { randomBytes, randomInt, randomUUID } from 'node:crypto';

import { hashSessionToken, SESSION_TOKEN_HASH } from '@qtiauth/service-kit';
import type { Kysely, Transaction } from 'kysely';
import { sql } from 'kysely';

import type { TicketCategory } from './categories.ts';
import type { Database } from './database.ts';
import { insertTicket, type TicketRecord } from './tickets.ts';

export const GUEST_CODE_LENGTH = 6;
export const GUEST_CODE = new RegExp(`^\\d{${String(GUEST_CODE_LENGTH)}}$`);
export const GUEST_ACTOR = { type: 'system', id: 'guest' } as const;

export function newGuestCode(): string {
  return randomInt(0, 10 ** GUEST_CODE_LENGTH)
    .toString()
    .padStart(GUEST_CODE_LENGTH, '0');
}

export function newGuestToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashGuestSecret(value: string): string {
  return hashSessionToken(value);
}

export function isGuestToken(value: string): boolean {
  return SESSION_TOKEN_HASH.test(value);
}

export async function issueGuestCode(
  db: Kysely<Database>,
  options: { email: string; emailNormalized: string; ttl: number; now: Date },
): Promise<string> {
  const code = newGuestCode();
  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable('guest_codes')
      .set({ used_at: options.now })
      .where('email_normalized', '=', options.emailNormalized)
      .where('used_at', 'is', null)
      .execute();
    await trx
      .insertInto('guest_codes')
      .values({
        id: randomUUID(),
        email: options.email,
        email_normalized: options.emailNormalized,
        code_hash: hashGuestSecret(code),
        created_at: options.now,
        expires_at: new Date(options.now.getTime() + options.ttl),
        used_at: null,
      })
      .execute();
  });
  return code;
}

async function consumeGuestCode(
  trx: Transaction<Database>,
  options: { emailNormalized: string; code: string; now: Date },
): Promise<boolean> {
  if (!GUEST_CODE.test(options.code)) return false;
  const row = await trx
    .selectFrom('guest_codes')
    .selectAll()
    .where('email_normalized', '=', options.emailNormalized)
    .where('code_hash', '=', hashGuestSecret(options.code))
    .where('used_at', 'is', null)
    .forUpdate()
    .executeTakeFirst();
  if (!row || row.expires_at <= options.now) return false;
  await trx
    .updateTable('guest_codes')
    .set({ used_at: options.now })
    .where('id', '=', row.id)
    .execute();
  return true;
}

export async function insertGuestLink(
  trx: Kysely<Database>,
  options: { ticketId: string; token: string; ttl: number; now: Date },
): Promise<void> {
  await trx
    .insertInto('guest_links')
    .values({
      id: randomUUID(),
      ticket_id: options.ticketId,
      token_hash: hashGuestSecret(options.token),
      created_at: options.now,
      expires_at: new Date(options.now.getTime() + options.ttl),
    })
    .execute();
}

export type OpenGuestResult =
  | { status: 'ok'; ticket: TicketRecord; token: string }
  | { status: 'unknown_category' }
  | { status: 'guest_category' }
  | { status: 'invalid_code' }
  | { status: 'too_long' };

export async function openGuestTicket(
  db: Kysely<Database>,
  options: {
    email: string;
    emailNormalized: string;
    code: string;
    categoryId: string;
    subject: string;
    body: string;
    categories: Map<string, TicketCategory>;
    maxSubject: number;
    maxBody: number;
    linkTtl: number;
    now: Date;
  },
): Promise<OpenGuestResult> {
  if (options.subject.length > options.maxSubject || options.body.length > options.maxBody) {
    return { status: 'too_long' };
  }
  const category = options.categories.get(options.categoryId);
  if (!category) return { status: 'unknown_category' };
  if (!category.guest_allowed || category.appeal) return { status: 'guest_category' };
  const token = newGuestToken();
  const ticket = await db.transaction().execute(async (trx) => {
    const consumed = await consumeGuestCode(trx, {
      emailNormalized: options.emailNormalized,
      code: options.code,
      now: options.now,
    });
    if (!consumed) return null;
    const opened = await insertTicket(trx, {
      id: randomUUID(),
      userId: null,
      guestEmail: options.email,
      categoryId: category.id,
      subject: options.subject.trim(),
      status: 'open',
      priority: 'normal',
      appeal: false,
      actionId: null,
      body: options.body,
      actor: GUEST_ACTOR,
      now: options.now,
    });
    await insertGuestLink(trx, {
      ticketId: opened.id,
      token,
      ttl: options.linkTtl,
      now: options.now,
    });
    return opened;
  });
  if (!ticket) return { status: 'invalid_code' };
  return { status: 'ok', ticket, token };
}

export async function issueGuestLink(
  db: Kysely<Database>,
  options: { ticketId: string; ttl: number; now: Date },
): Promise<string> {
  const token = newGuestToken();
  await insertGuestLink(db, { ...options, token });
  return token;
}

export async function ticketForGuestToken(
  db: Kysely<Database>,
  token: string,
  now: Date,
): Promise<TicketRecord | undefined> {
  if (!isGuestToken(token)) return undefined;
  const link = await db
    .selectFrom('guest_links')
    .select(['ticket_id', 'expires_at'])
    .where('token_hash', '=', hashGuestSecret(token))
    .executeTakeFirst();
  if (!link || link.expires_at <= now) return undefined;
  return db.selectFrom('tickets').selectAll().where('id', '=', link.ticket_id).executeTakeFirst();
}

export async function countedGuestAttempts(
  db: Kysely<Database>,
  options: { ip: string; window: number; now: Date },
): Promise<number> {
  const row = await db
    .selectFrom('guest_attempts')
    .select(['attempts', 'updated_at'])
    .where('ip', '=', options.ip)
    .executeTakeFirst();
  if (row === undefined) return 0;
  if (options.now.getTime() - row.updated_at.getTime() > options.window) return 0;
  return row.attempts;
}

export async function recordGuestAttempt(
  db: Kysely<Database>,
  options: { ip: string; now: Date },
): Promise<void> {
  await db
    .insertInto('guest_attempts')
    .values({ ip: options.ip, attempts: 1, updated_at: options.now })
    .onConflict((conflict) =>
      conflict.column('ip').doUpdateSet({
        attempts: sql`guest_attempts.attempts + 1`,
        updated_at: options.now,
      }),
    )
    .execute();
}

export async function sweepGuestSecrets(
  db: Kysely<Database>,
  options: { retention: number; now: Date },
): Promise<{ codes: number; links: number; attempts: number }> {
  const cutoff = new Date(options.now.getTime() - options.retention);
  const codes = await db
    .deleteFrom('guest_codes')
    .where('expires_at', '<', cutoff)
    .executeTakeFirst();
  const links = await db
    .deleteFrom('guest_links')
    .where('expires_at', '<', cutoff)
    .executeTakeFirst();
  const attempts = await db
    .deleteFrom('guest_attempts')
    .where('updated_at', '<', cutoff)
    .executeTakeFirst();
  return {
    codes: Number(codes.numDeletedRows),
    links: Number(links.numDeletedRows),
    attempts: Number(attempts.numDeletedRows),
  };
}
