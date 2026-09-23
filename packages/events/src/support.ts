export const SUPPORT_EVENTS = {
  ticketCreated: 'qtiauth.support.ticket.created.v1',
  ticketReplied: 'qtiauth.support.ticket.replied.v1',
  ticketStatusChanged: 'qtiauth.support.ticket.status_changed.v1',
} as const;

export type SupportEventType = (typeof SUPPORT_EVENTS)[keyof typeof SUPPORT_EVENTS];
