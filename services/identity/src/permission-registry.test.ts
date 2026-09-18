import { definePermissions } from '@qtiauth/service-kit';
import { describe, expect, it } from 'vitest';

import { mergeDeclaredPermissions } from './permission-registry.ts';

describe('mergeDeclaredPermissions', () => {
  it('keeps the local service’s permissions and drops expired peers by omission', () => {
    const own = definePermissions({
      'roles.manage': { description: 'Roles' },
      'users.edit_dob': { description: 'DOB' },
    });
    const listed = mergeDeclaredPermissions('identity', own, [
      {
        name: 'safety',
        version: '1.0.0',
        instances: 1,
        manifest: {
          service: 'safety',
          version: '1.0.0',
          routes: [],
          permissions: [
            { name: 'safety.reports.read', description: 'Reports', wildcard: true },
            { name: 'safety.csea.access', description: 'CSEA', wildcard: false },
          ],
          notifications: [],
        },
      },
    ]);
    expect(listed.map((item) => item.name)).toEqual([
      'roles.manage',
      'safety.csea.access',
      'safety.reports.read',
      'users.edit_dob',
    ]);
    expect(listed.find((item) => item.name === 'safety.csea.access')).toMatchObject({
      wildcard: false,
      service: 'safety',
    });
  });
});
