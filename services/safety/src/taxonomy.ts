import type { QtiauthConfig, SafetyPriority } from '@qtiauth/config';

export interface TaxonomySubtype {
  id: string;
  name: string;
}

export interface TaxonomyType {
  id: string;
  name: string;
  subtypes: readonly TaxonomySubtype[];
  default_priority: SafetyPriority;
  sla_ms: number;
  csea: boolean;
}

export class Taxonomy {
  readonly types: ReadonlyMap<string, TaxonomyType>;

  constructor(types: readonly TaxonomyType[]) {
    this.types = new Map(types.map((type) => [type.id, type]));
  }

  list(): readonly TaxonomyType[] {
    return [...this.types.values()];
  }

  type(id: string): TaxonomyType | undefined {
    return this.types.get(id);
  }

  resolve(typeId: string, subtypeId: string): TaxonomyType | undefined {
    const type = this.types.get(typeId);
    if (!type) return undefined;
    return type.subtypes.some((subtype) => subtype.id === subtypeId) ? type : undefined;
  }
}

export function loadTaxonomy(config: QtiauthConfig['safety']): Taxonomy {
  const types: TaxonomyType[] = Object.entries(config.taxonomy.types).map(([id, type]) => ({
    id,
    name: type.name,
    subtypes: type.subtypes.map((subtype) => ({ id: subtype.id, name: subtype.name })),
    default_priority: type.default_priority,
    sla_ms: type.sla,
    csea: type.csea,
  }));
  return new Taxonomy(types);
}

const PRIORITY_RANK: Record<SafetyPriority, number> = {
  low: 0,
  normal: 1,
  high: 2,
  urgent: 3,
};

export function higherPriority(a: SafetyPriority, b: SafetyPriority): SafetyPriority {
  return PRIORITY_RANK[a] >= PRIORITY_RANK[b] ? a : b;
}
