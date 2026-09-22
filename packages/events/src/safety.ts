export const SAFETY_EVENTS = {
  reportCreated: 'qtiauth.safety.report.created.v1',
  reportAcknowledged: 'qtiauth.safety.report.acknowledged.v1',
  reportSlaBreached: 'qtiauth.safety.report.sla_breached.v1',
  flagCreated: 'qtiauth.safety.flag.created.v1',
} as const;

export type SafetyEventType = (typeof SAFETY_EVENTS)[keyof typeof SAFETY_EVENTS];
