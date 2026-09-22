import type { NewEvent } from '@qtiauth/bus';
import type { SafetyPriority } from '@qtiauth/config';
import { type EventActor, SAFETY_EVENTS } from '@qtiauth/events';

export interface ReportTargetData {
  type: 'user' | 'content';
  id: string;
  user_id: string | null;
}

export interface ReportSourceData {
  kind: 'user' | 'game' | 'service';
  game_id: string | null;
  client_id: string | null;
}

export interface ReportCreatedData {
  report_id: string;
  type: string;
  subtype: string;
  priority: SafetyPriority;
  target: ReportTargetData;
  source: ReportSourceData;
  sla_deadline: string;
}

export interface ReportAcknowledgedData {
  report_id: string;
  recipient_hash: string | null;
}

export interface ReportSlaBreachedData {
  report_id: string;
  type: string;
  priority: SafetyPriority;
  sla_deadline: string;
  overdue_by_seconds: number;
}

export interface FlagCreatedData {
  report_id: string;
  type: string;
  subtype: string;
  priority: SafetyPriority;
  target: ReportTargetData;
  classifier: string;
  score: number;
  game_id: string | null;
}

export interface ReportActionedData {
  report_id: string;
  action_id: string;
  action: string;
  rule_id: string;
  target: ReportTargetData;
  restrictions?: string[];
  expires_at?: string | null;
  reason_code?: string | null;
}

export interface ReportDismissedData {
  report_id: string;
  type: string;
  priority: SafetyPriority;
  target: ReportTargetData;
}

export interface AppealCreatedData {
  appeal_id: string;
  action_id: string;
  action: string;
  user_id: string;
  ticket_id: string | null;
}

export interface AppealResolvedData {
  appeal_id: string;
  action_id: string;
  action: string;
  user_id: string;
  outcome: 'lifted' | 'upheld';
  restrictions?: string[];
}

export interface ContentRemovalRequestedData {
  report_id: string;
  action_id: string;
  target: { type: 'content'; id: string; user_id: string | null };
  game_id: string | null;
}

const SYSTEM_ACTOR: EventActor = { type: 'system', id: 'safety' };

export function reportCreatedEvent(
  reportId: string,
  data: ReportCreatedData,
  actor: EventActor,
): NewEvent<ReportCreatedData> {
  return {
    type: SAFETY_EVENTS.reportCreated,
    actor,
    subject: { type: 'report', id: reportId },
    data,
  };
}

export function reportAcknowledgedEvent(
  reportId: string,
  data: ReportAcknowledgedData,
): NewEvent<ReportAcknowledgedData> {
  return {
    type: SAFETY_EVENTS.reportAcknowledged,
    actor: SYSTEM_ACTOR,
    subject: { type: 'report', id: reportId },
    data,
  };
}

export function reportSlaBreachedEvent(
  reportId: string,
  data: ReportSlaBreachedData,
): NewEvent<ReportSlaBreachedData> {
  return {
    type: SAFETY_EVENTS.reportSlaBreached,
    actor: SYSTEM_ACTOR,
    subject: { type: 'report', id: reportId },
    data,
  };
}

export function flagCreatedEvent(
  reportId: string,
  data: FlagCreatedData,
  actor: EventActor,
): NewEvent<FlagCreatedData> {
  return {
    type: SAFETY_EVENTS.flagCreated,
    actor,
    subject: { type: 'report', id: reportId },
    data,
  };
}

export function reportActionedEvent(
  reportId: string,
  data: ReportActionedData,
  actor: EventActor,
): NewEvent<ReportActionedData> {
  return {
    type: SAFETY_EVENTS.reportActioned,
    actor,
    subject: { type: 'report', id: reportId },
    data,
  };
}

export function reportDismissedEvent(
  reportId: string,
  data: ReportDismissedData,
  actor: EventActor,
): NewEvent<ReportDismissedData> {
  return {
    type: SAFETY_EVENTS.reportDismissed,
    actor,
    subject: { type: 'report', id: reportId },
    data,
  };
}

export function appealCreatedEvent(
  appealId: string,
  data: AppealCreatedData,
  actor: EventActor,
): NewEvent<AppealCreatedData> {
  return {
    type: SAFETY_EVENTS.appealCreated,
    actor,
    subject: { type: 'appeal', id: appealId },
    data,
  };
}

export function appealResolvedEvent(
  appealId: string,
  data: AppealResolvedData,
  actor: EventActor,
): NewEvent<AppealResolvedData> {
  return {
    type: SAFETY_EVENTS.appealResolved,
    actor,
    subject: { type: 'appeal', id: appealId },
    data,
  };
}

export function contentRemovalRequestedEvent(
  reportId: string,
  data: ContentRemovalRequestedData,
  actor: EventActor,
): NewEvent<ContentRemovalRequestedData> {
  return {
    type: SAFETY_EVENTS.contentRemovalRequested,
    actor,
    subject: { type: 'report', id: reportId },
    data,
  };
}
