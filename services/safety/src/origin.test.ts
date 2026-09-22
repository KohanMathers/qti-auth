import { sections } from '@qtiauth/config';
import { describe, expect, it } from 'vitest';

import { appealUrl, cseaCaseUrl } from './origin.ts';

describe('safety origins', () => {
  const surfaces = sections.surfaces.parse({
    account: { hosts: ['account.example.com'] },
  });

  it('builds appeal and CSEA case links from the account surface', () => {
    expect(appealUrl(surfaces, 'action-1')).toBe('https://account.example.com/appeals/action-1');
    expect(cseaCaseUrl(surfaces, 'case-1')).toBe(
      'https://account.example.com/admin/safety/csea/case-1',
    );
  });
});
