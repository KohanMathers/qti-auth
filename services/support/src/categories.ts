import type { QtiauthConfig } from '@qtiauth/config';

export interface TicketCategory {
  id: string;
  name: string;
  guest_allowed: boolean;
  appeal: boolean;
}

export function loadCategories(config: QtiauthConfig['support']): Map<string, TicketCategory> {
  return new Map(
    Object.entries(config.categories).map(([id, category]) => [
      id,
      { id, name: category.name, guest_allowed: category.guest_allowed, appeal: category.appeal },
    ]),
  );
}

export function appealCategory(
  categories: Map<string, TicketCategory>,
): TicketCategory | undefined {
  return [...categories.values()].find((category) => category.appeal);
}

export function categoryOf(
  categories: Map<string, TicketCategory>,
  id: string,
): TicketCategory | undefined {
  return categories.get(id);
}
