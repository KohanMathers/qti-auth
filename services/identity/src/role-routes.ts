import {
  effectivePermissions,
  PERMISSION_GRANT,
  ProblemError,
  type Router,
} from '@qtiauth/service-kit';
import * as z from 'zod';

import { findAccount } from './accounts.ts';
import { NO_STORE } from './headers.ts';
import { listedPermissions } from './permission-registry.ts';
import {
  createRole,
  deleteRole,
  getRole,
  listRoles,
  loadUserRoles,
  ROLE_DESCRIPTION_MAX,
  ROLE_NAME_MAX,
  ROLE_SLUG,
  type RoleRecord,
  setUserRoles,
  updateRole,
} from './roles.ts';
import type { Context } from './service.ts';
import { signedIn } from './session-routes.ts';

const grantSchema = z
  .string()
  .regex(PERMISSION_GRANT, 'Must be a permission, a prefix like users.*, or *');

const permissionSchema = z.object({
  name: z.string(),
  description: z.string(),
  wildcard: z.boolean(),
  service: z.string(),
});

const roleSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  builtin: z.boolean(),
  permissions: z.array(z.string()),
  effective: z.array(permissionSchema),
  updated_at: z.iso.datetime(),
});

const rolesBody = z.object({
  items: z.array(roleSchema),
});

function presented(role: RoleRecord, ctx: Context) {
  const declared = listedPermissions(ctx);
  return {
    id: role.id,
    slug: role.slug,
    name: role.name,
    description: role.description,
    builtin: role.builtin,
    permissions: role.permissions,
    effective: effectivePermissions(role.permissions, declared),
    updated_at: role.updated_at.toISOString(),
  };
}

function roleError(result: { status: string; grant?: string }): never {
  switch (result.status) {
    case 'not_found':
      throw new ProblemError('ROLE_NOT_FOUND');
    case 'slug_taken':
      throw new ProblemError('ROLE_SLUG_TAKEN');
    case 'builtin':
      throw new ProblemError('ROLE_BUILTIN');
    case 'invalid_grant':
      throw new ProblemError('VALIDATION_FAILED', {
        detail: `Permission grant ${result.grant ?? ''} is not valid`,
      });
    default:
      throw new ProblemError('ROLE_NOT_FOUND');
  }
}

export function roleRoutes(router: Router<Context>): void {
  router.route({
    method: 'GET',
    path: '/api/v1/admin/permissions',
    operation_id: 'listPermissions',
    summary: 'Permissions declared by running services',
    description:
      'Built from service manifests, so a disabled service’s permissions are absent. Permissions with wildcard false are never matched by *.',
    tags: ['roles'],
    auth: 'session',
    permissions: ['roles.manage'],
    rate_limit: 'global',
    responses: {
      200: {
        description: 'Currently declared permissions',
        schema: z.object({ items: z.array(permissionSchema) }),
      },
    },
    handler: ({ ctx }) =>
      Promise.resolve({
        status: 200 as const,
        headers: NO_STORE,
        body: { items: listedPermissions(ctx) },
      }),
  });

  router.route({
    method: 'GET',
    path: '/api/v1/admin/roles',
    operation_id: 'listRoles',
    summary: 'Staff roles',
    tags: ['roles'],
    auth: 'session',
    permissions: ['roles.manage'],
    rate_limit: 'global',
    responses: { 200: { description: 'Roles', schema: rolesBody } },
    handler: async ({ ctx }) => {
      const roles = await listRoles(ctx.db);
      return {
        status: 200,
        headers: NO_STORE,
        body: { items: roles.map((role) => presented(role, ctx)) },
      };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/admin/roles',
    operation_id: 'createRole',
    summary: 'Create a staff role',
    tags: ['roles'],
    auth: 'session',
    permissions: ['roles.manage'],
    step_up: true,
    rate_limit: 'global',
    request: {
      body: z.object({
        slug: z.string().regex(ROLE_SLUG, 'Must be a lowercase slug like support_agent'),
        name: z.string().trim().min(1).max(ROLE_NAME_MAX),
        description: z.string().trim().min(1).max(ROLE_DESCRIPTION_MAX),
        permissions: z.array(grantSchema).default([]),
      }),
    },
    responses: { 201: { description: 'The role was created', schema: roleSchema } },
    errors: ['ROLE_SLUG_TAKEN'],
    handler: async ({ ctx, identity, body, log }) => {
      const { userId } = signedIn(identity);
      const result = await createRole(ctx.db, {
        slug: body.slug,
        name: body.name,
        description: body.description,
        permissions: body.permissions,
        actor: { type: 'user', id: userId },
        now: new Date(),
      });
      if (result.status !== 'ok') roleError(result);
      ctx.outbox.wake();
      log.info('role created', { role_id: result.role.id });
      return { status: 201, headers: NO_STORE, body: presented(result.role, ctx) };
    },
  });

  router.route({
    method: 'GET',
    path: '/api/v1/admin/roles/:role_id',
    operation_id: 'getRole',
    summary: 'A staff role',
    tags: ['roles'],
    auth: 'session',
    permissions: ['roles.manage'],
    rate_limit: 'global',
    request: { params: z.object({ role_id: z.uuid() }) },
    responses: { 200: { description: 'The role', schema: roleSchema } },
    errors: ['ROLE_NOT_FOUND'],
    handler: async ({ ctx, params }) => {
      const role = await getRole(ctx.db, params.role_id);
      if (!role) throw new ProblemError('ROLE_NOT_FOUND');
      return { status: 200, headers: NO_STORE, body: presented(role, ctx) };
    },
  });

  router.route({
    method: 'PATCH',
    path: '/api/v1/admin/roles/:role_id',
    operation_id: 'updateRole',
    summary: 'Edit a staff role',
    tags: ['roles'],
    auth: 'session',
    permissions: ['roles.manage'],
    step_up: true,
    rate_limit: 'global',
    request: {
      params: z.object({ role_id: z.uuid() }),
      body: z
        .object({
          name: z.string().trim().min(1).max(ROLE_NAME_MAX).optional(),
          description: z.string().trim().min(1).max(ROLE_DESCRIPTION_MAX).optional(),
          permissions: z.array(grantSchema).optional(),
        })
        .refine(
          (body) =>
            body.name !== undefined ||
            body.description !== undefined ||
            body.permissions !== undefined,
          { message: 'Set name, description or permissions' },
        ),
    },
    responses: { 200: { description: 'The role was updated', schema: roleSchema } },
    errors: ['ROLE_NOT_FOUND'],
    handler: async ({ ctx, identity, params, body, log }) => {
      const { userId } = signedIn(identity);
      const result = await updateRole(ctx.db, {
        roleId: params.role_id,
        actor: { type: 'user', id: userId },
        now: new Date(),
        ...(body.name === undefined ? {} : { name: body.name }),
        ...(body.description === undefined ? {} : { description: body.description }),
        ...(body.permissions === undefined ? {} : { permissions: body.permissions }),
      });
      if (result.status !== 'ok') roleError(result);
      ctx.outbox.wake();
      log.info('role updated', { role_id: result.role.id });
      return { status: 200, headers: NO_STORE, body: presented(result.role, ctx) };
    },
  });

  router.route({
    method: 'DELETE',
    path: '/api/v1/admin/roles/:role_id',
    operation_id: 'deleteRole',
    summary: 'Delete a custom staff role',
    description: 'Built-in roles seeded from config cannot be deleted.',
    tags: ['roles'],
    auth: 'session',
    permissions: ['roles.manage'],
    step_up: true,
    rate_limit: 'global',
    request: { params: z.object({ role_id: z.uuid() }) },
    responses: { 204: { description: 'The role was deleted' } },
    errors: ['ROLE_NOT_FOUND', 'ROLE_BUILTIN'],
    handler: async ({ ctx, identity, params, log }) => {
      const { userId } = signedIn(identity);
      const result = await deleteRole(ctx.db, {
        roleId: params.role_id,
        actor: { type: 'user', id: userId },
      });
      if (result.status !== 'deleted') roleError(result);
      ctx.outbox.wake();
      log.info('role deleted', { role_id: params.role_id });
      return { status: 204, headers: NO_STORE };
    },
  });

  router.route({
    method: 'GET',
    path: '/api/v1/admin/users/:user_id/roles',
    operation_id: 'listUserRoles',
    summary: 'Roles assigned to a user',
    tags: ['roles'],
    auth: 'session',
    permissions: ['roles.manage'],
    rate_limit: 'global',
    request: { params: z.object({ user_id: z.uuid() }) },
    responses: { 200: { description: 'The user’s roles', schema: rolesBody } },
    errors: ['ACCOUNT_NOT_FOUND'],
    handler: async ({ ctx, params }) => {
      const account = await findAccount(ctx.db, params.user_id);
      if (!account || account.state === 'deleted') throw new ProblemError('ACCOUNT_NOT_FOUND');
      const roles = await loadUserRoles(ctx.db, params.user_id);
      return {
        status: 200,
        headers: NO_STORE,
        body: { items: roles.map((role) => presented(role, ctx)) },
      };
    },
  });

  router.route({
    method: 'PUT',
    path: '/api/v1/admin/users/:user_id/roles',
    operation_id: 'setUserRoles',
    summary: 'Replace the roles assigned to a user',
    tags: ['roles'],
    auth: 'session',
    permissions: ['roles.manage'],
    step_up: true,
    rate_limit: 'global',
    request: {
      params: z.object({ user_id: z.uuid() }),
      body: z.object({ role_ids: z.array(z.uuid()) }),
    },
    responses: { 200: { description: 'The user’s roles', schema: rolesBody } },
    errors: ['ACCOUNT_NOT_FOUND', 'ROLE_NOT_FOUND'],
    handler: async ({ ctx, identity, params, body, log }) => {
      const { userId } = signedIn(identity);
      const result = await setUserRoles(ctx.db, {
        userId: params.user_id,
        roleIds: body.role_ids,
        actor: { type: 'user', id: userId },
      });
      if (result.status === 'not_found') throw new ProblemError('ACCOUNT_NOT_FOUND');
      if (result.status === 'unknown_role') throw new ProblemError('ROLE_NOT_FOUND');
      ctx.outbox.wake();
      log.info('user roles updated', { user_id: params.user_id });
      return {
        status: 200,
        headers: NO_STORE,
        body: { items: result.roles.map((role) => presented(role, ctx)) },
      };
    },
  });
}
