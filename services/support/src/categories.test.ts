import { sections } from '@qtiauth/config';
import { describe, expect, it } from 'vitest';

import { appealCategory, loadCategories } from './categories.ts';

describe('ticket categories', () => {
  const categories = loadCategories(sections.support.parse({}));

  it('loads built-in categories with one appeal type', () => {
    expect(categories.get('account')).toMatchObject({ name: 'Account', appeal: false });
    expect(appealCategory(categories)).toMatchObject({ id: 'appeal', name: 'Appeal' });
  });
});
