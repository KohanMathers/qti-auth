import { describe, expect, it } from 'vitest';

import { revisionDocument, unifiedDiff } from './diff.ts';

describe('unifiedDiff', () => {
  it('marks changed lines and keeps the common ones', () => {
    expect(unifiedDiff('a\nb\nc', 'a\nx\nc')).toBe(' a\n-b\n+x\n c');
  });

  it('diffs a revision document so a restore can be compared', () => {
    const before = revisionDocument({
      title: 'First',
      slug: 'first',
      status: 'draft',
      category_id: 'cat',
      tags: ['one'],
      body: 'Hello',
    });
    const after = revisionDocument({
      title: 'First',
      slug: 'first',
      status: 'published',
      category_id: 'cat',
      tags: ['one', 'two'],
      body: 'Hello',
    });
    expect(unifiedDiff(before, after)).toContain('-status: draft');
    expect(unifiedDiff(before, after)).toContain('+status: published');
    expect(unifiedDiff(before, after)).toContain('-tags: one');
    expect(unifiedDiff(before, after)).toContain('+tags: one two');
  });
});
