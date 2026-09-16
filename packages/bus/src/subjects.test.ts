import { describe, expect, it } from 'vitest';

import { consumerName, cronSubject, rpcQueueGroup, rpcSubject, workSubject } from './subjects.ts';

describe('subjects', () => {
  it('follows the spec formats', () => {
    expect(rpcSubject('identity', 'get_user_summary')).toBe(
      'qtiauth.rpc.identity.get_user_summary',
    );
    expect(rpcQueueGroup('identity')).toBe('qtiauth.rpc.identity');
    expect(cronSubject('retention.sweep')).toBe('qtiauth.sys.cron.retention.sweep');
    expect(workSubject('notifier', 'email')).toBe('qtiauth.work.notifier.email');
  });

  it('rejects tokens that would change the subject', () => {
    expect(() => rpcSubject('identity', 'get.user')).toThrow('Invalid RPC method: get.user');
    expect(() => rpcSubject('*', 'get_user')).toThrow('Invalid service name: *');
    expect(() => cronSubject('retention.>')).toThrow('Invalid cron job name: retention.>');
    expect(() => workSubject('notifier', 'email ')).toThrow('Invalid work queue name');
  });

  it('builds consumer names NATS accepts', () => {
    expect(consumerName('identity', 'cron', 'retention.sweep')).toBe(
      'identity-cron-retention_sweep',
    );
    expect(() => consumerName('identity', 'a b')).toThrow('Invalid consumer name');
  });
});
