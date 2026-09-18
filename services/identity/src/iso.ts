export function iso(date: Date | null | undefined): string | null {
  return date?.toISOString() ?? null;
}
