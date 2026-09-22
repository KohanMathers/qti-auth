export const CSEA_CHECKLIST_FIELDS = [
  'reporting_person_name',
  'reporting_person_email',
  'reporting_person_telephone',
  'detected_content',
  'detection_method',
  'platform',
  'previous_report',
  'previous_nca_reference',
  'uploaded_at',
  'upload_ip',
  'upload_ip_at',
  'exif',
  'content_url',
  'original_hash',
  'account_username',
  'billing_details',
  'email',
  'recovery_email',
  'telephone',
  'telephone_verified_at',
  'profile_url',
  'login_ips',
  'declaration',
] as const;

export type CseaChecklistField = (typeof CSEA_CHECKLIST_FIELDS)[number];

export interface CseaChecklistItem {
  available: boolean;
  value: string;
}

export type CseaChecklist = Record<CseaChecklistField, CseaChecklistItem>;

export type CseaChecklistPatch = Partial<
  Record<CseaChecklistField, { available?: boolean | undefined; value?: string | undefined }>
>;

export function emptyChecklistItem(available = false, value = ''): CseaChecklistItem {
  return { available, value };
}

export function emptyChecklist(): CseaChecklist {
  return Object.fromEntries(
    CSEA_CHECKLIST_FIELDS.map((field) => [field, emptyChecklistItem()]),
  ) as CseaChecklist;
}

export function detectionMethod(source: string): string {
  if (source === 'automated') return 'automated flag';
  if (source === 'game') return 'game report';
  if (source === 'service') return 'service report';
  return 'user report';
}

export function prefillChecklist(options: {
  source: string;
  gameId: string | null;
  capturedAt: Date | null;
  hasSnapshot: boolean;
  now: Date;
}): CseaChecklist {
  const checklist = emptyChecklist();
  checklist.detection_method = emptyChecklistItem(true, detectionMethod(options.source));
  if (options.gameId !== null) checklist.platform = emptyChecklistItem(true, options.gameId);
  const uploaded = options.capturedAt ?? options.now;
  checklist.uploaded_at = emptyChecklistItem(true, uploaded.toISOString());
  checklist.detected_content = emptyChecklistItem(
    options.hasSnapshot,
    options.hasSnapshot ? 'held' : '',
  );
  checklist.previous_report = emptyChecklistItem(true, 'false');
  checklist.declaration = emptyChecklistItem(false, 'false');
  return checklist;
}

export function parseChecklist(value: unknown): CseaChecklist {
  const base = emptyChecklist();
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return base;
  const record = value as Record<string, unknown>;
  for (const field of CSEA_CHECKLIST_FIELDS) {
    const item = record[field];
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
    const available = 'available' in item && item.available === true;
    const raw = 'value' in item && typeof item.value === 'string' ? item.value : '';
    base[field] = { available, value: raw.slice(0, 2_000) };
  }
  return base;
}

export function mergeChecklist(current: CseaChecklist, patch: CseaChecklistPatch): CseaChecklist {
  const next = { ...current };
  for (const field of CSEA_CHECKLIST_FIELDS) {
    const update = patch[field];
    if (update === undefined) continue;
    next[field] = {
      available: update.available ?? current[field].available,
      value: update.value !== undefined ? update.value.slice(0, 2_000) : current[field].value,
    };
  }
  return next;
}

export function declarationComplete(checklist: CseaChecklist): boolean {
  return checklist.declaration.available && checklist.declaration.value === 'true';
}
