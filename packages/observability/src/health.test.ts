import { describe, expect, it, vi } from 'vitest';

import { healthResponse, liveness, readiness } from './health.ts';

describe('liveness', () => {
  it('is always ok', async () => {
    const response = healthResponse(liveness('identity'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', service: 'identity' });
  });
});

describe('readiness', () => {
  it('is ok when every check passes', async () => {
    const result = await readiness(
      'identity',
      { database: () => Promise.resolve(), nats: () => Promise.resolve() },
      { timeout: 100 },
    );
    expect(result).toEqual({
      status: 'ok',
      service: 'identity',
      checks: {
        database: { status: 'ok', duration_ms: expect.any(Number) as unknown },
        nats: { status: 'ok', duration_ms: expect.any(Number) as unknown },
      },
    });
    expect(healthResponse(result).status).toBe(200);
  });

  it('reports failed and slow checks without their error messages', async () => {
    const onError = vi.fn();
    const result = await readiness(
      'identity',
      {
        database: () => Promise.reject(new Error('password authentication failed for qtiauth')),
        valkey: () => new Promise((resolve) => setTimeout(resolve, 1_000)),
        nats: () => Promise.resolve(),
      },
      { timeout: 50, onError },
    );

    expect(result.status).toBe('unavailable');
    expect(result.checks['database']?.status).toBe('failed');
    expect(result.checks['valkey']?.status).toBe('timeout');
    expect(result.checks['nats']?.status).toBe('ok');
    expect(onError).toHaveBeenCalledWith('database', expect.any(Error));

    const response = healthResponse(result);
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).not.toContain('password');
  });
});
