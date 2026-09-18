import { PERMISSION_GRANT } from '@qtiauth/config';

const PERMISSION = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;

export interface PermissionDefinition {
  description: string;
  wildcard?: boolean;
}

export interface DeclaredPermission {
  name: string;
  description: string;
  wildcard: boolean;
}

export type PermissionRegistry = Readonly<Record<string, DeclaredPermission>>;

export class PermissionDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermissionDefinitionError';
  }
}

export function isPermissionName(name: string): boolean {
  return PERMISSION.test(name);
}

export function isPermissionGrant(grant: string): boolean {
  return PERMISSION_GRANT.test(grant);
}

export function definePermissions<const P extends string>(
  permissions: Record<P, PermissionDefinition>,
): Readonly<Record<P, DeclaredPermission>> {
  const declared: Record<string, DeclaredPermission> = {};
  for (const [name, definition] of Object.entries<PermissionDefinition>(permissions)) {
    if (!isPermissionName(name)) {
      throw new PermissionDefinitionError(
        `Permission ${name} must be dotted lowercase words, like users.read`,
      );
    }
    if (definition.description.trim() === '') {
      throw new PermissionDefinitionError(`Permission ${name} needs a description`);
    }
    declared[name] = {
      name,
      description: definition.description,
      wildcard: definition.wildcard ?? true,
    };
  }
  return Object.freeze(declared);
}

export function grantMatches(grant: string, permission: DeclaredPermission): boolean {
  if (grant === permission.name) return true;
  if (!permission.wildcard || !PERMISSION_GRANT.test(grant)) return false;
  if (grant === '*') return true;
  return grant.endsWith('.*') && permission.name.startsWith(grant.slice(0, -1));
}

export function grantsOverlap(left: string, right: string): boolean {
  if (!PERMISSION_GRANT.test(left) || !PERMISSION_GRANT.test(right)) return false;
  if (left === right || left === '*' || right === '*') return true;
  if (left.endsWith('.*') && right.startsWith(left.slice(0, -1))) return true;
  if (right.endsWith('.*') && left.startsWith(right.slice(0, -1))) return true;
  return false;
}

export function effectivePermissions<T extends DeclaredPermission>(
  grants: readonly string[],
  declared: readonly T[],
): T[] {
  return declared.filter((permission) => grants.some((grant) => grantMatches(grant, permission)));
}

export function missingPermissions(
  granted: readonly string[],
  required: readonly DeclaredPermission[],
): string[] {
  return required
    .filter((permission) => !granted.some((grant) => grantMatches(grant, permission)))
    .map((permission) => permission.name);
}
