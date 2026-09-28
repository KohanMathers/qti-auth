import { defineErrors } from '@qtiauth/service-kit';

export const WEB_ERRORS = defineErrors({
  ASSET_NOT_FOUND: { status: 404, title: 'No such asset' },
  LOCALE_NOT_AVAILABLE: { status: 404, title: 'No catalogue for this locale' },
});
