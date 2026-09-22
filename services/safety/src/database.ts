import type { SafetyPriority } from '@qtiauth/config';
import type { Generated } from 'kysely';

export const REPORT_STATUSES = ['open', 'triaged', 'resolved', 'dismissed'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const REPORT_TARGET_TYPES = ['user', 'content'] as const;
export type ReportTargetType = (typeof REPORT_TARGET_TYPES)[number];

export const REPORT_SOURCES = ['user', 'game', 'service', 'automated'] as const;
export type ReportSource = (typeof REPORT_SOURCES)[number];

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

export interface Database {
  reports: ReportsTable;
  report_snapshots: ReportSnapshotsTable;
}
