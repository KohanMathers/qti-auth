import { defineErrors } from '@qtiauth/service-kit';

export const NOTIFIER_ERRORS = defineErrors({
  WEBHOOK_ENDPOINT_NOT_FOUND: { status: 404, title: 'No such webhook endpoint' },
  WEBHOOK_DELIVERY_NOT_FOUND: { status: 404, title: 'No such webhook delivery' },
  WEBHOOK_TARGET_INVALID: {
    status: 400,
    title: 'This webhook URL is not allowed',
  },
});
