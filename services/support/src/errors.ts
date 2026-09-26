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
  SUPPORT_GUEST_DISABLED: {
    status: 404,
    title: 'Guest tickets are not enabled here',
  },
  SUPPORT_CAPTCHA_REQUIRED: { status: 403, title: 'Complete the CAPTCHA to continue' },
  SUPPORT_CAPTCHA_INVALID: { status: 400, title: 'The CAPTCHA was not accepted' },
  SUPPORT_GUEST_CODE_INVALID: { status: 400, title: 'That code is not valid' },
  SUPPORT_GUEST_LINK_INVALID: { status: 404, title: 'That link is not valid' },
  SUPPORT_CATEGORY_GUEST: {
    status: 400,
    title: 'This category is not open to guest tickets',
  },
  SUPPORT_ATTACHMENTS_DISABLED: {
    status: 404,
    title: 'Ticket attachments are not enabled here',
  },
  SUPPORT_ATTACHMENT_INVALID: { status: 400, title: 'This file cannot be attached' },
  SUPPORT_ATTACHMENT_NOT_FOUND: { status: 404, title: 'No such attachment' },
  SUPPORT_STORAGE_UNAVAILABLE: { status: 503, title: 'Object storage is not available' },
  SUPPORT_KB_DISABLED: { status: 404, title: 'The knowledge base is not enabled here' },
  SUPPORT_KB_ARTICLE_NOT_FOUND: { status: 404, title: 'No such article' },
  SUPPORT_KB_CATEGORY_NOT_FOUND: { status: 404, title: 'No such category' },
  SUPPORT_KB_CATEGORY_IN_USE: {
    status: 409,
    title: 'This category still has articles',
  },
  SUPPORT_KB_SLUG_TAKEN: { status: 409, title: 'That slug is already in use' },
  SUPPORT_KB_INVALID: { status: 400, title: 'This article or category is not valid' },
  SUPPORT_KB_REVISION_NOT_FOUND: { status: 404, title: 'No such revision' },
  SUPPORT_KB_SESSION_REQUIRED: {
    status: 401,
    title: 'A session is required to vote on knowledge-base articles',
  },
  SUPPORT_KB_IMAGE_NOT_FOUND: { status: 404, title: 'No such image' },
  SUPPORT_KB_IMAGE_INVALID: { status: 400, title: 'That image cannot be uploaded' },
});
