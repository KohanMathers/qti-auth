import type { SafetyPriority } from '@qtiauth/config';
import type { Generated } from 'kysely';

export const REPORT_STATUSES = ['open', 'triaged', 'resolved', 'dismissed'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const REPORT_TARGET_TYPES = ['user', 'content'] as const;
export type ReportTargetType = (typeof REPORT_TARGET_TYPES)[number];

export const REPORT_SOURCES = ['user', 'game', 'service', 'automated'] as const;
export type ReportSource = (typeof REPORT_SOURCES)[number];

export const ACTION_TYPES = [
  'warn',
  'restrict',
  'force_username_reset',
  'lock',
  'ban',
  'remove_content',
  'proscribed_org_removal',
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export const ACTION_STATUSES = ['applied', 'pending_approval', 'lifted'] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];

export const APPEAL_STATUSES = ['open', 'lifted', 'upheld'] as const;
export type AppealStatus = (typeof APPEAL_STATUSES)[number];

export const APPROVAL_STATUSES = ['pending', 'approved', 'cancelled'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const CSEA_CASE_STATUSES = ['open', 'submitted', 'closed', 'destroyed'] as const;
export type CseaCaseStatus = (typeof CSEA_CASE_STATUSES)[number];

export const CSEA_EVIDENCE_KINDS = ['snapshot', 'metadata'] as const;
export type CseaEvidenceKind = (typeof CSEA_EVIDENCE_KINDS)[number];

export interface ReportsTable {
  id: string;
  status: ReportStatus;
  type: string;
  subtype: string;
  priority: SafetyPriority;
  csea: boolean;
  target_type: ReportTargetType;
  target_id: string;
  target_user_id: string | null;
  source: ReportSource;
  reporter_user_id: string | null;
  reporter_contact: string | null;
  reporter_locale: string | null;
  game_id: string | null;
  client_id: string | null;
  classifier: string | null;
  classifier_score: number | null;
  note: string | null;
  context: Record<string, unknown> | null;
  sla_deadline: Date;
  sla_breach_notified_at: Date | null;
  outcome: string | null;
  outcome_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ReportSnapshotsTable {
  report_id: string;
  content_type: string;
  content: string;
  captured_at: Date;
  created_at: Generated<Date>;
}

export interface ModerationActionsTable {
  id: string;
  report_id: string;
  user_id: string | null;
  action: ActionType;
  status: ActionStatus;
  rule_id: string;
  restrictions: string[];
  expires_at: Date | null;
  reason_code: string | null;
  actor_id: string;
  created_at: Date;
  updated_at: Generated<Date>;
}

export interface ActionApprovalsTable {
  id: string;
  report_id: string;
  action_id: string;
  requested_by: string;
  approved_by: string | null;
  status: ApprovalStatus;
  created_at: Date;
  decided_at: Date | null;
}

export interface AppealsTable {
  id: string;
  action_id: string;
  user_id: string | null;
  body: string;
  status: AppealStatus;
  ticket_id: string | null;
  resolved_by: string | null;
  created_at: Date;
  resolved_at: Date | null;
}

export interface CseaCasesTable {
  id: string;
  report_id: string;
  status: CseaCaseStatus;
  nca_priority: number;
  nca_reference: string | null;
  submitted_at: Date | null;
  submission_deadline: Date;
  evidence_until: Date | null;
  reference_until: Date | null;
  legal_hold_id: string | null;
  target_user_id: string | null;
  checklist: Record<string, unknown>;
  closed_reason: string | null;
  actor_id: string | null;
  created_at: Date;
  updated_at: Generated<Date>;
  destroyed_at: Date | null;
}

export interface CseaEvidenceTable {
  id: string;
  case_id: string;
  kind: CseaEvidenceKind;
  content_type: string;
  sealed: string;
  storage_key: string | null;
  created_at: Date;
  destroyed_at: Date | null;
}

export interface Database {
  reports: ReportsTable;
  report_snapshots: ReportSnapshotsTable;
  moderation_actions: ModerationActionsTable;
  action_approvals: ActionApprovalsTable;
  appeals: AppealsTable;
  csea_cases: CseaCasesTable;
  csea_evidence: CseaEvidenceTable;
}
