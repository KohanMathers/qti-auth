import { sections } from '@qtiauth/config';
import { describe, expect, it } from 'vitest';

import { streamDefinitions } from './streams.ts';
import { cronSubject, rpcSubject, workSubject } from './subjects.ts';

function matches(filter: string, subject: string): boolean {
  const pattern = filter
    .split('.')
    .map((token) => (token === '>' ? '.+' : token === '*' ? '[^.]+' : token))
    .join('\\.');
  return new RegExp(`^${pattern}$`).test(subject);
}

describe('streamDefinitions', () => {
  const streams = streamDefinitions(sections.bus.parse({}));
  const streamFor = (subject: string) =>
    streams.filter((s) => s.subjects.some((f) => matches(f, subject))).map((s) => s.name);

  it('routes each kind of subject to exactly one stream', () => {
    expect(streamFor('qtiauth.identity.user.banned.v1')).toEqual(['QTIAUTH_EVENTS']);
    expect(streamFor('qtiauth.audit.recorded.v1')).toEqual(['QTIAUTH_EVENTS']);
    expect(streamFor(cronSubject('retention.sweep'))).toEqual(['QTIAUTH_CRON']);
    expect(streamFor(workSubject('notifier', 'email'))).toEqual(['QTIAUTH_WORK']);
  });

  it('keeps request/reply and announcements out of streams', () => {
    expect(streamFor(rpcSubject('identity', 'export_user'))).toEqual([]);
    expect(streamFor('qtiauth.sys.announce')).toEqual([]);
  });

  it('uses the configured retention', () => {
    expect(streams.map((s) => [s.name, s.retention, s.maxAge])).toEqual([
      ['QTIAUTH_EVENTS', 'limits', 7 * 86_400_000],
      ['QTIAUTH_CRON', 'interest', 7 * 86_400_000],
      ['QTIAUTH_WORK', 'workqueue', 7 * 86_400_000],
    ]);
  });
});
