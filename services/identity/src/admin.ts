import { writeEvent } from '@qtiauth/bus';
import type { Kysely } from 'kysely';

import type { Database } from './database.ts';
import { insertEmailToken } from './email-tokens.ts';
import { type AuditRecordedData, auditRecordedEvent } from './events.ts';
import { adminExists, seedRoles, type RoleDefinition } from './roles.ts';

export type AdminCreateResult =
  { status: 'admin_exists' } | { status: 'issued'; token: string; expiresAt: Date };

export async function issueAdminSignup(
  db: Kysely<Database>,
  options: {
    email: string;
    locale: string | null;
    ttl: number;
    normalizeEmail: (address: string) => string;
    roles: Record<string, RoleDefinition>;
    now: Date;
  },
): Promise<AdminCreateResult> {
  await seedRoles(db, options.roles, options.now);
  return db.transaction().execute(async (trx): Promise<AdminCreateResult> => {
    if (await adminExists(trx)) return { status: 'admin_exists' };

    await trx
      .updateTable('email_tokens')
      .set({ used_at: options.now })
      .where('purpose', '=', 'admin_signup')
      .where('used_at', 'is', null)
      .execute();

    const expiresAt = new Date(options.now.getTime() + options.ttl);
    const token = await insertEmailToken(trx, {
      purpose: 'admin_signup',
      email: options.email.trim(),
      emailNormalized: options.normalizeEmail(options.email),
      locale: options.locale,
      returnTo: null,
      userId: null,
      expiresAt,
      now: options.now,
    });
    await writeEvent<Database, AuditRecordedData>(
      trx,
      auditRecordedEvent(
        { type: 'system', id: 'identity' },
        { action: 'admin.bootstrap', target_type: 'role', target_id: 'admin' },
      ),
    );
    return { status: 'issued', token, expiresAt };
  });
}
