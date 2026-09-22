export const SAFETY_EVENTS = {
  reportCreated: 'qtiauth.safety.report.created.v1',
  reportAcknowledged: 'qtiauth.safety.report.acknowledged.v1',
  reportActioned: 'qtiauth.safety.report.actioned.v1',
  reportDismissed: 'qtiauth.safety.report.dismissed.v1',
  reportSlaBreached: 'qtiauth.safety.report.sla_breached.v1',
  flagCreated: 'qtiauth.safety.flag.created.v1',
  appealCreated: 'qtiauth.safety.appeal.created.v1',
  appealResolved: 'qtiauth.safety.appeal.resolved.v1',
  contentRemovalRequested: 'qtiauth.safety.content.removal_requested.v1',
  cseaCaseOpened: 'qtiauth.safety.csea.case_opened.v1',
  cseaEnforced: 'qtiauth.safety.csea.enforced.v1',
} as const;

export type SafetyEventType = (typeof SAFETY_EVENTS)[keyof typeof SAFETY_EVENTS];
