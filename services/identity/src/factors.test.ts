import { describe, expect, it } from 'vitest';

import { permissionNeeds2fa, staffNeeds2fa } from './factors.ts';

describe('staffNeeds2fa', () => {
  const patterns = ['users.*', 'safety.*', 'webhooks.manage'];

  it('matches exact permissions and prefixes', () => {
    expect(permissionNeeds2fa('users.ban', patterns)).toBe(true);
    expect(permissionNeeds2fa('safety.reports.read', patterns)).toBe(true);
    expect(permissionNeeds2fa('webhooks.manage', patterns)).toBe(true);
    expect(permissionNeeds2fa('oidc.clients.verify', patterns)).toBe(false);
    expect(staffNeeds2fa(['profile.read'], patterns)).toBe(false);
    expect(staffNeeds2fa(['users.read', 'profile.read'], patterns)).toBe(true);
    expect(staffNeeds2fa(['*'], patterns)).toBe(true);
  });
});
