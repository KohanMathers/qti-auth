import { sections } from '@qtiauth/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger, hashUserId, type LoggerOptions } from './logger.ts';
import { withSpan } from './spans.ts';
import { assertLogsScrubbed, captureLogs, startTestTracing, type TestTracing } from './testing.ts';

let tracing: TestTracing;

beforeAll(() => {
  tracing = startTestTracing();
});

afterAll(async () => {
  await tracing.shutdown();
});

function logger(logs: Partial<LoggerOptions['config']> = {}) {
  const captured = captureLogs();
  const config = sections.observability.parse({
    logs: { user_id_hash_key: 'key', ...logs },
  }).logs;
  return {
    captured,
    log: createLogger({ service: 'identity', config, destination: captured.destination }),
  };
}

describe('createLogger', () => {
  it('writes one JSON line per record with the service and level', () => {
    const { captured, log } = logger();
    log.info('signed in', { method: 'password' });

    expect(captured.lines).toHaveLength(1);
    expect(captured.lines[0]?.endsWith('\n')).toBe(true);
    expect(captured.records()[0]).toEqual({
      time: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) as unknown,
      level: 'info',
      service: 'identity',
      message: 'signed in',
      method: 'password',
    });
  });

  it('skips records below the configured level', () => {
    const { captured, log } = logger({ level: 'warn' });
    log.info('ignored');
    log.warn('kept');
    expect(captured.records().map((r) => r['message'])).toEqual(['kept']);
    expect(log.isLevelEnabled('debug')).toBe(false);
    expect(log.isLevelEnabled('error')).toBe(true);
  });

  it('hashes user IDs and never writes secrets', () => {
    const { captured, log } = logger({ redact_keys: ['binding_code'] });
    const child = log.child({ request_id: 'req-1', user_id: '01J9ZUSER' });
    child.warn('password sign-in failed', {
      password: 'correct horse battery staple',
      body: { refresh_token: 'rt-5f2c9a', totp_code: '492817', binding_code: 'BX-7731' },
      error: Object.assign(new Error('rejected'), { authorization: 'Bearer at-81ac' }),
    });

    const [record] = captured.records();
    expect(record).toMatchObject({
      request_id: 'req-1',
      user_id: hashUserId('key', '01J9ZUSER'),
    });
    assertLogsScrubbed(captured.lines, [
      '01J9ZUSER',
      'correct horse battery staple',
      'rt-5f2c9a',
      '492817',
      'BX-7731',
      'at-81ac',
    ]);
  });

  it("doesn't let fields overwrite the standard ones", () => {
    const { captured, log } = logger();
    log.error('boom', { level: 'info', service: 'other', message: 'fake', trace_id: 'x' });
    expect(captured.records()[0]).toMatchObject({
      level: 'error',
      service: 'identity',
      message: 'boom',
    });
    expect(captured.records()[0]).not.toHaveProperty('trace_id');
  });

  it('adds the active trace and span IDs', async () => {
    const { captured, log } = logger();
    const ids = await withSpan('work', {}, (span) => {
      log.info('inside');
      return Promise.resolve(span.spanContext());
    });
    expect(captured.records()[0]).toMatchObject({ trace_id: ids.traceId, span_id: ids.spanId });
  });
});

describe('hashUserId', () => {
  it('is stable per key and hides the ID', () => {
    expect(hashUserId('a', 'u1')).toBe(hashUserId('a', 'u1'));
    expect(hashUserId('a', 'u1')).not.toBe(hashUserId('b', 'u1'));
    expect(hashUserId('a', 'u1')).toMatch(/^[0-9a-f]{32}$/);
  });
});
