import { openApiDocument } from '@qtiauth/service-kit';
import { describe, expect, it } from 'vitest';

import { router } from './service.ts';

describe('scheduler service', () => {
  it('announces itself without any routes', () => {
    expect(router.manifest()).toMatchObject({ service: 'scheduler', routes: [] });
    expect(openApiDocument(router)).toMatchObject({ paths: {} });
  });
});
