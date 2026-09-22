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
});
