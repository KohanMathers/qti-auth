export interface PageDefinition {
  path: string;
  surface?: 'account' | 'support';
  requires?: Readonly<Record<string, boolean>>;
}

export const PAGES: Readonly<Record<string, PageDefinition>>;
