import { openApiDocument } from '@qtiauth/service-kit';
import { describe, expect, it } from 'vitest';

import { router } from './service.ts';

describe('template service', () => {
  it('has a route manifest', () => {
    expect(router.manifest()).toMatchObject({
      service: 'template',
      routes: [{ method: 'GET', path: '/api/v1/template/hello', auth: 'session' }],
    });
  });

  it('has an OpenAPI document', () => {
    expect(openApiDocument(router)).toMatchObject({
      openapi: '3.1.1',
      paths: { '/api/v1/template/hello': { get: { operationId: 'hello' } } },
    });
  });
});
