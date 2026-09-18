import type { Bus } from '@qtiauth/bus';
import { describe, expect, it, vi } from 'vitest';

import { createEmailJob, emailJobSchema, EmailRequestError, queueEmail } from './queue.ts';

const request = {
  template: 'magic_link',
  to: { address: 'someone@example.com' },
  locale: 'en-gb',
  userId: '0199a0e0-0000-7000-8000-00000000abcd',
  variables: { link: 'https://me.example.com/magic/abc', expires_in_minutes: 15 },
} as const;

describe('createEmailJob', () => {
  it('builds a job with a delivery ID and a canonical locale', () => {
    const job = createEmailJob(request, new Date('2026-09-17T09:00:00Z'));
    expect(job.delivery_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(job).toEqual({
      delivery_id: job.delivery_id,
      template: 'magic_link',
      locale: 'en-GB',
      to: { address: 'someone@example.com', name: null },
      user_id: request.userId,
      variables: request.variables,
      queued_at: '2026-09-17T09:00:00.000Z',
      attachments: [],
    });
    expect(emailJobSchema.parse(job)).toEqual(job);
  });

  it('refuses missing or invalid variables before anything is queued', () => {
    expect(() =>
      createEmailJob({
        ...request,
        locale: 'not a locale',
        to: { address: 'nobody' },
        variables: { link: 'javascript:alert(1)' } as unknown as typeof request.variables,
      }),
    ).toThrow(
      expect.objectContaining({
        name: 'EmailRequestError',
        issues: [
          expect.stringMatching(/^variables\.link: /),
          expect.stringMatching(/^variables\.expires_in_minutes: /),
          'locale: Must be a locale like en-GB',
          expect.stringMatching(/^to\.address: /),
        ],
      }),
    );
  });

  it('refuses templates that do not exist', () => {
    expect(() =>
      createEmailJob({ ...request, template: 'nope' } as unknown as Parameters<
        typeof createEmailJob
      >[0]),
    ).toThrow(new EmailRequestError('nope', ['template: Unknown template']));
  });
});

describe('queueEmail', () => {
  it('publishes to the queue for the template priority, deduplicated by delivery ID', async () => {
    const publish = vi.fn(() => Promise.resolve());
    const bus = { js: { publish } } as unknown as Bus;

    const job = await queueEmail(bus, request);

    expect(publish).toHaveBeenCalledWith(
      'qtiauth.work.notifier.email.high',
      JSON.stringify(job),
      expect.objectContaining({ msgID: job.delivery_id }),
    );
  });
});
