import { sections } from '@qtiauth/config';
import { describe, expect, it } from 'vitest';

import { isPermanentBan, loadCatalog, ruleOf } from './catalog.ts';

describe('moderation catalog', () => {
  const catalog = loadCatalog(sections.safety.parse({}));

  it('loads built-in actions, rules and restrictions', () => {
    expect(catalog.actions.get('ban')).toMatchObject({ name: 'Ban', enabled: true });
    expect(ruleOf(catalog, 'hate')?.name).toBe('Hate and harassment');
    expect(catalog.restrictions).toEqual(['chat', 'ugc', 'username_change']);
    expect(catalog.requireSecondApproval).toBe(false);
  });

  it('treats bans and proscribed organisation removal as permanent', () => {
    expect(isPermanentBan('ban')).toBe(true);
    expect(isPermanentBan('proscribed_org_removal')).toBe(true);
    expect(isPermanentBan('lock')).toBe(false);
  });
});
