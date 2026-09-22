import { sections } from '@qtiauth/config';
import { describe, expect, it } from 'vitest';

import { higherPriority, loadTaxonomy } from './taxonomy.ts';

function safety(overrides: Record<string, unknown> = {}) {
  return sections.safety.parse(overrides);
}

describe('loadTaxonomy', () => {
  it('ships the default OSA-mapped types with CSEA and terrorism at a 1h SLA', () => {
    const taxonomy = loadTaxonomy(safety());
    const csea = taxonomy.type('csea');
    const terrorism = taxonomy.type('terrorism');
    expect(csea?.csea).toBe(true);
    expect(csea?.sla_ms).toBe(60 * 60 * 1_000);
    expect(csea?.default_priority).toBe('urgent');
    expect(terrorism?.csea).toBe(false);
    expect(terrorism?.sla_ms).toBe(60 * 60 * 1_000);
    expect(taxonomy.type('hate')?.sla_ms).toBe(24 * 60 * 60 * 1_000);
  });

  it('resolves only known subtypes under their type', () => {
    const taxonomy = loadTaxonomy(safety());
    expect(taxonomy.resolve('hate', 'targeted_harassment')?.id).toBe('hate');
    expect(taxonomy.resolve('hate', 'unknown')).toBeUndefined();
    expect(taxonomy.resolve('made_up', 'anything')).toBeUndefined();
  });

  it('merges custom types with the built-in ones', () => {
    const taxonomy = loadTaxonomy(
      safety({
        taxonomy: {
          types: {
            cheating: {
              name: 'Cheating',
              default_priority: 'normal',
              sla: '48h',
              csea: false,
              subtypes: [{ id: 'exploits', name: 'Exploits' }],
            },
          },
        },
      }),
    );
    expect(taxonomy.type('cheating')?.name).toBe('Cheating');
    expect(taxonomy.type('csea')?.csea).toBe(true);
  });
});

describe('higherPriority', () => {
  it('picks the more urgent of two priorities', () => {
    expect(higherPriority('low', 'normal')).toBe('normal');
    expect(higherPriority('urgent', 'high')).toBe('urgent');
    expect(higherPriority('normal', 'normal')).toBe('normal');
  });
});
