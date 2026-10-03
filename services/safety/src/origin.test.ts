import { sections } from '@qtiauth/config';
import { describe, expect, it } from 'vitest';

import { appealUrl, cseaCaseUrl } from './origin.ts';

describe('safety origins', () => {
  const surfaces = sections.surfaces.parse({
    account: { hosts: ['account.example.com'] },
    support: { hosts: ['account.example.com'], base_path: '/support' },
  });

  it('builds the appeal link on the support surface and the CSEA link on the account surface', () => {
    expect(appealUrl(surfaces, 'action-1')).toBe(
      'https://account.example.com/support/appeals/new?action_id=action-1',
    );
    expect(cseaCaseUrl(surfaces, 'case-1')).toBe('https://account.example.com/admin/csea/case-1');
  });
});
