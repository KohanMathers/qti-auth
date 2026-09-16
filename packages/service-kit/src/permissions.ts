const PERMISSION = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const GRANT = /^(?:\*|[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*(?:\.\*)?)$/;

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
  if (!permission.wildcard || !GRANT.test(grant)) return false;
  if (grant === '*') return true;
  return grant.endsWith('.*') && permission.name.startsWith(grant.slice(0, -1));
}

export function missingPermissions(
  granted: readonly string[],
  required: readonly DeclaredPermission[],
): string[] {
  return required
    .filter((permission) => !granted.some((grant) => grantMatches(grant, permission)))
    .map((permission) => permission.name);
}
