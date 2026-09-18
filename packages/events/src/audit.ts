export const AUDIT_EVENTS = {
  recorded: 'qtiauth.audit.recorded.v1',
} as const;

export type AuditEventType = (typeof AUDIT_EVENTS)[keyof typeof AUDIT_EVENTS];
