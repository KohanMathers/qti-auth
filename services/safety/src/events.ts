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
