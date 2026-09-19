import type { QtiauthConfig } from '@qtiauth/config';

export type ScopeConfig = QtiauthConfig['oidc']['scopes'];

export function parseScopeString(value: string | undefined): string[] | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const scopes = value
    .split(/[ +]/)
    .map((scope) => scope.trim())
    .filter((scope) => scope !== '');
  if (scopes.length === 0 || new Set(scopes).size !== scopes.length) return undefined;
  return scopes;
}

export function requestedScopes(
  requested: readonly string[],
  configured: ScopeConfig,
  allowed: readonly string[] | null,
): string[] | undefined {
  const known = new Set(Object.keys(configured));
  const permitted = allowed === null ? known : new Set(allowed);
  if (requested.some((scope) => !known.has(scope) || !permitted.has(scope))) return undefined;
  return [...requested];
}

export function missingConsent(
  requested: readonly string[],
  granted: readonly string[] | undefined,
): string[] {
  if (granted === undefined) return [...requested];
  return requested.filter((scope) => !granted.includes(scope));
}

export function claimsFor(scopes: readonly string[], configured: ScopeConfig): string[] {
  const claims = new Set<string>();
  for (const scope of scopes) {
    for (const claim of configured[scope]?.claims ?? []) claims.add(claim);
  }
  return [...claims];
}

export function includesOpenId(scopes: readonly string[]): boolean {
  return scopes.includes('openid');
}

export function includesOfflineAccess(scopes: readonly string[]): boolean {
  return scopes.includes('offline_access');
}
