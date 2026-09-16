import { describe, expect, it } from 'vitest';

import { health } from './health.ts';

describe('health', () => {
  it('reports ok with the service name', () => {
    expect(health('example')).toEqual({ status: 'ok', service: 'example' });
  });
});
