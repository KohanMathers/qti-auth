import { defineErrors } from '@qtiauth/service-kit';

export const SAFETY_ERRORS = defineErrors({
  SAFETY_REPORT_NOT_FOUND: { status: 404, title: 'No such report' },
  SAFETY_TAXONOMY_UNKNOWN: {
    status: 400,
    title: 'Unknown report type or subtype',
  },
  SAFETY_TARGET_INVALID: {
    status: 400,
    title: 'This report target is not accepted',
  },
  SAFETY_INTAKE_DISABLED: {
    status: 404,
    title: 'The report intake API is not enabled here',
  },
  SAFETY_GAME_MISMATCH: {
    status: 403,
    title: 'This game may not report on behalf of another game',
  },
  SAFETY_MODERATION_DISABLED: {
    status: 404,
    title: 'Moderation is not enabled here',
  },
  SAFETY_APPEALS_DISABLED: {
    status: 404,
    title: 'Appeals are not enabled here',
  },
  SAFETY_REPORT_CLOSED: {
    status: 409,
    title: 'This report has already been actioned or dismissed',
  },
  SAFETY_ACTION_UNKNOWN: {
    status: 400,
    title: 'Unknown or disabled moderation action',
  },
  SAFETY_RULE_REQUIRED: {
    status: 400,
    title: 'A rule from the configured list is required',
  },
  SAFETY_RESTRICTION_UNKNOWN: {
    status: 400,
    title: 'Unknown restriction',
  },
  SAFETY_LOCK_EXPIRY_INVALID: {
    status: 400,
    title: 'A lock needs an expiry in the future',
  },
  SAFETY_ACTION_SELF: {
    status: 409,
    title: 'You cannot apply this action to your own account',
  },
  SAFETY_APPROVAL_NOT_FOUND: { status: 404, title: 'No such pending approval' },
  SAFETY_APPROVAL_SELF: {
    status: 409,
    title: 'A second, different moderator must confirm this ban',
  },
  SAFETY_APPROVAL_CLOSED: {
    status: 409,
    title: 'This approval is no longer pending',
  },
  SAFETY_APPEAL_NOT_FOUND: { status: 404, title: 'No such appeal' },
  SAFETY_APPEAL_EXISTS: {
    status: 409,
    title: 'An open appeal already exists for this action',
  },
  SAFETY_APPEAL_NOT_ALLOWED: {
    status: 409,
    title: 'This action cannot be appealed',
  },
  SAFETY_APPEAL_CLOSED: {
    status: 409,
    title: 'This appeal has already been resolved',
  },
  SAFETY_APPEAL_INVALID: {
    status: 400,
    title: 'This appeal is too long',
  },
});
