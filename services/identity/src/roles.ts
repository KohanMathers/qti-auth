import { randomUUIDv7 } from 'node:crypto';

import { writeEvent } from '@qtiauth/bus';
import { ADMIN_ROLE } from '@qtiauth/config';
import type { EventActor } from '@qtiauth/events';
import { isPermissionGrant } from '@qtiauth/service-kit';
import type { Kysely, Selectable } from 'kysely';

import type { Database, RolesTable } from './database.ts';
import {
  type AuditRecordedData,
  auditRecordedEvent,
  type UserUpdatedData,
  userUpdatedEvent,
} from './events.ts';

export const ROLE_SLUG = /^[a-z][a-z0-9_]{0,62}$/;
export const ROLE_NAME_MAX = 80;
export const ROLE_DESCRIPTION_MAX = 500;

export type RoleRow = Selectable<RolesTable>;

export interface RoleDefinition {
  name: string;
  description: string;
  permissions: readonly string[];
}

export interface RoleRecord {
  id: string;
  slug: string;
  name: string;
  description: string;
  builtin: boolean;
  permissions: string[];
  created_at: Date;
  updated_at: Date;
}

export type RoleWriteResult =
  | { status: 'ok'; role: RoleRecord }
  | { status: 'not_found' }
  | { status: 'slug_taken' }
  | { status: 'builtin' }
  | { status: 'invalid_grant'; grant: string };

export async function seedRoles(
  db: Kysely<Database>,
  definitions: Record<string, RoleDefinition>,
  now = new Date(),
): Promise<void> {
  const existing = await db.selectFrom('roles').select('slug').execute();
  const have = new Set(existing.map((row) => row.slug));
  for (const [slug, definition] of Object.entries(definitions)) {
    if (have.has(slug)) continue;
    const id = randomUUIDv7();
    await db
      .insertInto('roles')
      .values({
        id,
        slug,
        name: definition.name,
        description: definition.description,
        builtin: true,
        created_at: now,
        updated_at: now,
      })
      .execute();
    if (definition.permissions.length > 0) {
      await db
        .insertInto('role_permissions')
        .values(definition.permissions.map((grant) => ({ role_id: id, grant })))
        .execute();
    }
  }
}

export async function loadPermissions(db: Kysely<Database>, userId: string): Promise<string[]> {
  const rows = await db
    .selectFrom('user_roles')
    .innerJoin('role_permissions', 'role_permissions.role_id', 'user_roles.role_id')
    .select('role_permissions.grant as grant')
    .where('user_roles.user_id', '=', userId)
    .distinct()
    .orderBy('grant')
    .execute();
  return rows.map((row) => row.grant);
}

export async function loadUserRoles(db: Kysely<Database>, userId: string): Promise<RoleRecord[]> {
  const rows = await db
    .selectFrom('user_roles')
    .innerJoin('roles', 'roles.id', 'user_roles.role_id')
    .selectAll('roles')
    .where('user_roles.user_id', '=', userId)
    .orderBy('roles.slug')
    .execute();
  return attachPermissions(db, rows);
}

async function attachPermissions(db: Kysely<Database>, rows: RoleRow[]): Promise<RoleRecord[]> {
  if (rows.length === 0) return [];
  const grants = await db
    .selectFrom('role_permissions')
    .select(['role_id', 'grant'])
    .where(
      'role_id',
      'in',
      rows.map((row) => row.id),
    )
    .orderBy('grant')
    .execute();
  const byRole = new Map<string, string[]>();
  for (const row of grants) {
    const list = byRole.get(row.role_id) ?? [];
    list.push(row.grant);
    byRole.set(row.role_id, list);
  }
  return rows.map((row) => ({
    ...row,
    permissions: byRole.get(row.id) ?? [],
  }));
}

export async function listRoles(db: Kysely<Database>): Promise<RoleRecord[]> {
  const rows = await db.selectFrom('roles').selectAll().orderBy('slug').execute();
  return attachPermissions(db, rows);
}

export async function getRole(
  db: Kysely<Database>,
  roleId: string,
): Promise<RoleRecord | undefined> {
  const row = await db.selectFrom('roles').selectAll().where('id', '=', roleId).executeTakeFirst();
  if (!row) return undefined;
  const [role] = await attachPermissions(db, [row]);
  return role;
}

function checkedGrants(grants: readonly string[]): { grants: string[] } | { invalid: string } {
  const unique = [...new Set(grants)];
  const invalid = unique.find((grant) => !isPermissionGrant(grant));
  if (invalid !== undefined) return { invalid };
  return { grants: unique };
}

async function writeRoleAudit(
  trx: Kysely<Database>,
  options: {
    actor: EventActor;
    action: string;
    roleId: string;
    userIds: readonly string[];
  },
): Promise<void> {
  await writeEvent<Database, AuditRecordedData>(
    trx,
    auditRecordedEvent(options.actor, {
      action: options.action,
      target_type: 'role',
      target_id: options.roleId,
    }),
  );
  for (const userId of options.userIds) {
    await writeEvent<Database, UserUpdatedData>(
      trx,
      userUpdatedEvent(userId, { fields: ['roles'] }, options.actor),
    );
  }
}

async function membersOf(db: Kysely<Database>, roleId: string): Promise<string[]> {
  const rows = await db
    .selectFrom('user_roles')
    .select('user_id')
    .where('role_id', '=', roleId)
    .execute();
  return rows.map((row) => row.user_id);
}

export async function createRole(
  db: Kysely<Database>,
  options: {
    slug: string;
    name: string;
    description: string;
    permissions: readonly string[];
    actor: EventActor;
    now: Date;
  },
): Promise<RoleWriteResult> {
  const grants = checkedGrants(options.permissions);
  if ('invalid' in grants) return { status: 'invalid_grant', grant: grants.invalid };

  return db.transaction().execute(async (trx): Promise<RoleWriteResult> => {
    const taken = await trx
      .selectFrom('roles')
      .select('id')
      .where('slug', '=', options.slug)
      .executeTakeFirst();
    if (taken) return { status: 'slug_taken' };
    const id = randomUUIDv7();
    await trx
      .insertInto('roles')
      .values({
        id,
        slug: options.slug,
        name: options.name,
        description: options.description,
        builtin: false,
        created_at: options.now,
        updated_at: options.now,
      })
      .execute();
    if (grants.grants.length > 0) {
      await trx
        .insertInto('role_permissions')
        .values(grants.grants.map((grant) => ({ role_id: id, grant })))
        .execute();
    }
    await writeRoleAudit(trx, {
      actor: options.actor,
      action: 'role.created',
      roleId: id,
      userIds: [],
    });
    const role = await getRole(trx, id);
    if (!role) return { status: 'not_found' };
    return { status: 'ok', role };
  });
}

export async function updateRole(
  db: Kysely<Database>,
  options: {
    roleId: string;
    name?: string;
    description?: string;
    permissions?: readonly string[];
    actor: EventActor;
    now: Date;
  },
): Promise<RoleWriteResult> {
  const grants = options.permissions === undefined ? undefined : checkedGrants(options.permissions);
  if (grants !== undefined && 'invalid' in grants) {
    return { status: 'invalid_grant', grant: grants.invalid };
  }

  return db.transaction().execute(async (trx): Promise<RoleWriteResult> => {
    const existing = await trx
      .selectFrom('roles')
      .selectAll()
      .where('id', '=', options.roleId)
      .executeTakeFirst();
    if (!existing) return { status: 'not_found' };
    await trx
      .updateTable('roles')
      .set({
        ...(options.name === undefined ? {} : { name: options.name }),
        ...(options.description === undefined ? {} : { description: options.description }),
        updated_at: options.now,
      })
      .where('id', '=', options.roleId)
      .execute();
    if (grants !== undefined) {
      await trx.deleteFrom('role_permissions').where('role_id', '=', options.roleId).execute();
      if (grants.grants.length > 0) {
        await trx
          .insertInto('role_permissions')
          .values(grants.grants.map((grant) => ({ role_id: options.roleId, grant })))
          .execute();
      }
    }
    const userIds = grants === undefined ? [] : await membersOf(trx, options.roleId);
    await writeRoleAudit(trx, {
      actor: options.actor,
      action: 'role.updated',
      roleId: options.roleId,
      userIds,
    });
    const role = await getRole(trx, options.roleId);
    if (!role) return { status: 'not_found' };
    return { status: 'ok', role };
  });
}

export async function deleteRole(
  db: Kysely<Database>,
  options: { roleId: string; actor: EventActor },
): Promise<RoleWriteResult | { status: 'deleted' }> {
  return db.transaction().execute(async (trx) => {
    const existing = await trx
      .selectFrom('roles')
      .selectAll()
      .where('id', '=', options.roleId)
      .executeTakeFirst();
    if (!existing) return { status: 'not_found' };
    if (existing.builtin) return { status: 'builtin' };
    const userIds = await membersOf(trx, options.roleId);
    await writeRoleAudit(trx, {
      actor: options.actor,
      action: 'role.deleted',
      roleId: options.roleId,
      userIds,
    });
    await trx.deleteFrom('roles').where('id', '=', options.roleId).execute();
    return { status: 'deleted' };
  });
}

export async function setUserRoles(
  db: Kysely<Database>,
  options: { userId: string; roleIds: readonly string[]; actor: EventActor },
): Promise<
  { status: 'ok'; roles: RoleRecord[] } | { status: 'not_found' } | { status: 'unknown_role' }
> {
  const unique = [...new Set(options.roleIds)];
  return db.transaction().execute(async (trx) => {
    const user = await trx
      .selectFrom('users')
      .select('id')
      .where('id', '=', options.userId)
      .where('state', '!=', 'deleted')
      .executeTakeFirst();
    if (!user) return { status: 'not_found' };
    if (unique.length > 0) {
      const found = await trx.selectFrom('roles').select('id').where('id', 'in', unique).execute();
      if (found.length !== unique.length) return { status: 'unknown_role' };
    }
    await trx.deleteFrom('user_roles').where('user_id', '=', options.userId).execute();
    if (unique.length > 0) {
      await trx
        .insertInto('user_roles')
        .values(unique.map((roleId) => ({ user_id: options.userId, role_id: roleId })))
        .execute();
    }
    await writeEvent<Database, AuditRecordedData>(
      trx,
      auditRecordedEvent(options.actor, {
        action: 'user.roles.updated',
        target_type: 'user',
        target_id: options.userId,
      }),
    );
    await writeEvent<Database, UserUpdatedData>(
      trx,
      userUpdatedEvent(options.userId, { fields: ['roles'] }, options.actor),
    );
    return { status: 'ok', roles: await loadUserRoles(trx, options.userId) };
  });
}

export async function adminExists(db: Kysely<Database>): Promise<boolean> {
  const row = await db
    .selectFrom('user_roles')
    .innerJoin('roles', 'roles.id', 'user_roles.role_id')
    .select('user_roles.user_id')
    .where('roles.slug', '=', ADMIN_ROLE)
    .executeTakeFirst();
  return row !== undefined;
}

export async function assignAdminIfFirst(db: Kysely<Database>, userId: string): Promise<boolean> {
  const admin = await db
    .selectFrom('roles')
    .select('id')
    .where('slug', '=', ADMIN_ROLE)
    .executeTakeFirst();
  if (!admin) return false;
  const held = await db
    .selectFrom('user_roles')
    .select('user_id')
    .where('role_id', '=', admin.id)
    .executeTakeFirst();
  if (held) return false;
  await db.insertInto('user_roles').values({ user_id: userId, role_id: admin.id }).execute();
  await writeEvent<Database, UserUpdatedData>(
    db,
    userUpdatedEvent(userId, { fields: ['roles'] }, { type: 'system', id: 'identity' }),
  );
  return true;
}

export async function grantUser(
  db: Kysely<Database>,
  userId: string,
  grants: readonly string[],
): Promise<void> {
  const roleId = randomUUIDv7();
  const now = new Date();
  await db
    .insertInto('roles')
    .values({
      id: roleId,
      slug: `grant_${roleId.replaceAll('-', '')}`,
      name: 'Grant',
      description: 'Test grant',
      builtin: false,
      created_at: now,
      updated_at: now,
    })
    .execute();
  if (grants.length > 0) {
    await db
      .insertInto('role_permissions')
      .values(grants.map((grant) => ({ role_id: roleId, grant })))
      .execute();
  }
  await db.insertInto('user_roles').values({ user_id: userId, role_id: roleId }).execute();
}
