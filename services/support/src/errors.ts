import { defineErrors } from '@qtiauth/service-kit';

export const SUPPORT_ERRORS = defineErrors({
  SUPPORT_TICKETS_DISABLED: {
    status: 404,
    title: 'Support tickets are not enabled here',
  },
  SUPPORT_TICKET_NOT_FOUND: { status: 404, title: 'No such ticket' },
  SUPPORT_CATEGORY_UNKNOWN: {
    status: 400,
    title: 'Unknown ticket category',
  },
  SUPPORT_CATEGORY_APPEAL: {
    status: 400,
    title: 'Appeals must be opened as an appeal, not a regular ticket',
  },
  SUPPORT_TICKET_CLOSED: {
    status: 409,
    title: 'This ticket is closed',
  },
  SUPPORT_TICKET_OPEN: {
    status: 409,
    title: 'This ticket is still open',
  },
  SUPPORT_TICKET_RATED: {
    status: 409,
    title: 'This ticket has already been rated',
  },
  SUPPORT_APPEAL_EXISTS: {
    status: 409,
    title: 'An open appeal already exists for this action',
  },
  SUPPORT_TICKET_INVALID: {
    status: 400,
    title: 'This ticket is too long',
  },
  SUPPORT_MACRO_NOT_FOUND: { status: 404, title: 'No such canned response' },
});
