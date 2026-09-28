import { KIT_ERRORS } from '@qtiauth/service-kit';

export interface ProblemMessage {
  title: string;
  detail: string;
}

export type ProblemCatalogue = Readonly<Record<string, ProblemMessage>>;

export const CATALOGUE: ProblemCatalogue = Object.freeze({
  VALIDATION_FAILED: {
    title: 'Something in the form is not right',
    detail: 'Check the highlighted fields and try again.',
  },
  INVALID_JSON: {
    title: 'The request could not be read',
    detail: 'Reload the page and try again.',
  },
  INVALID_CURSOR: {
    title: 'The page you asked for is not available',
    detail: 'Start from the first page.',
  },
  IDENTITY_TOKEN_INVALID: {
    title: 'Your session could not be verified',
    detail: 'Sign in again.',
  },
  AUTH_MODE_NOT_ALLOWED: {
    title: 'That action needs a different kind of sign-in',
    detail: 'Sign in with the required method and try again.',
  },
  PERMISSION_DENIED: {
    title: 'You do not have permission to do that',
    detail: 'Ask an administrator for the needed permission.',
  },
  INSUFFICIENT_SCOPE: {
    title: 'This app is missing a required permission',
    detail: 'Re-authorize the app to grant the missing scope.',
  },
  ACCOUNT_STATE_NOT_ALLOWED: {
    title: 'Your account cannot do that right now',
    detail: 'Finish any pending steps on your account and try again.',
  },
  NOT_FOUND: {
    title: 'We could not find that',
    detail: 'Check the address and try again.',
  },
  UNSUPPORTED_MEDIA_TYPE: {
    title: 'That request format is not supported',
    detail: 'Reload the page and try again.',
  },
  INTERNAL_ERROR: {
    title: 'Something went wrong on our side',
    detail: 'Try again in a moment. If it keeps happening, get in touch.',
  },
  SERVICE_UNAVAILABLE: {
    title: 'The service is temporarily unavailable',
    detail: 'Try again in a few minutes.',
  },
  ASSET_NOT_FOUND: {
    title: 'That file is not part of this deployment',
    detail: 'Reload the page.',
  },
  LOCALE_NOT_AVAILABLE: {
    title: 'That language is not available',
    detail: 'The default language will be used instead.',
  },
});

export class CatalogueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogueError';
  }
}

export function assertKitCoverage(catalogue: ProblemCatalogue = CATALOGUE): void {
  const missing = Object.keys(KIT_ERRORS).filter((code) => !(code in catalogue));
  if (missing.length > 0) {
    throw new CatalogueError(`Missing catalogue entries for: ${missing.sort().join(', ')}`);
  }
}

export function messageFor(catalogue: ProblemCatalogue, code: string): ProblemMessage {
  return (
    catalogue[code] ?? {
      title: 'Something went wrong',
      detail: 'Try again in a moment.',
    }
  );
}
