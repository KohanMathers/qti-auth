import { describe, expect, it } from 'vitest';

import {
  defineErrors,
  ErrorDefinitionError,
  KIT_ERRORS,
  mergeErrors,
  PROBLEM_CONTENT_TYPE,
  problemDetails,
  ProblemError,
  problemResponse,
} from './problems.ts';

describe('defineErrors', () => {
  it('rejects badly named codes, non-error statuses and empty titles', () => {
    expect(() => defineErrors({ userNotFound: { status: 404, title: 'No user' } })).toThrow(
      'must be UPPER_SNAKE_CASE',
    );
    expect(() => defineErrors({ CREATED: { status: 201, title: 'Created' } })).toThrow(
      'must have a 4xx or 5xx status',
    );
    expect(() => defineErrors({ EMPTY: { status: 400, title: ' ' } })).toThrow('needs a title');
  });
});

describe('mergeErrors', () => {
  it('refuses to redefine a code', () => {
    const service = defineErrors({ VALIDATION_FAILED: { status: 422, title: 'Nope' } });
    expect(() => mergeErrors(KIT_ERRORS, service)).toThrow(ErrorDefinitionError);
  });

  it('allows the same definition twice', () => {
    expect(mergeErrors(KIT_ERRORS, KIT_ERRORS)).toEqual(KIT_ERRORS);
  });
});

describe('problemDetails', () => {
  const errors = mergeErrors(
    KIT_ERRORS,
    defineErrors({ USER_NOT_FOUND: { status: 404, title: 'User not found' } }),
  );

  it('builds RFC 9457 members from the registry', () => {
    const error = new ProblemError('USER_NOT_FOUND', {
      detail: 'Checked the primary',
      extensions: { user_ref: 'abc', status: 200, code: 'OTHER' },
    });
    expect(problemDetails(errors, error, 'req-1')).toEqual({
      type: 'urn:qtiauth:problem:USER_NOT_FOUND',
      title: 'User not found',
      status: 404,
      code: 'USER_NOT_FOUND',
      detail: 'Checked the primary',
      request_id: 'req-1',
      user_ref: 'abc',
    });
  });

  it('throws for unregistered codes', () => {
    expect(() => problemDetails(errors, new ProblemError('NOPE'))).toThrow('not registered');
  });
});

describe('problemResponse', () => {
  it('uses the problem content type and status', async () => {
    const problem = problemDetails(KIT_ERRORS, new ProblemError('NOT_FOUND'));
    const response = problemResponse(problem, { 'retry-after': '5' });
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toBe(PROBLEM_CONTENT_TYPE);
    expect(response.headers.get('retry-after')).toBe('5');
    expect(await response.json()).toEqual(problem);
  });
});
