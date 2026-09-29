import { randomUUIDv7 } from 'node:crypto';

import { type Bus, consumeWork, provisionStreams } from '@qtiauth/bus';
import { EMAIL_PRIORITIES, type EmailJob, emailQueue } from '@qtiauth/email';
import type { Kysely } from 'kysely';

import type { Database } from './database.ts';

export interface CapturedEmails {
  jobs: EmailJob[];
  nextJob: (address: string, template?: string, timeout?: number) => Promise<EmailJob>;
  nextLink: (address: string, timeout?: number) => Promise<URL>;
  stop: () => Promise<void>;
}

export async function captureEmails(bus: Bus): Promise<CapturedEmails> {
  if (bus.service !== 'notifier') {
    throw new Error('Capture email from a bus connected as notifier');
  }
  await provisionStreams(bus.jsm, bus.config);
  const jobs: EmailJob[] = [];
  const taken = new Set<string>();
  const consumers = await Promise.all(
    EMAIL_PRIORITIES.map((priority) =>
      consumeWork<EmailJob>(bus, {
        queue: emailQueue(priority),
        handler: (message) => {
          jobs.push(message.data);
          return Promise.resolve();
        },
        onError: () => undefined,
      }),
    ),
  );

  const nextJob = async (address: string, template?: string, timeout = 10_000) => {
    const deadline = Date.now() + timeout;
    for (;;) {
      const job = jobs.find(
        (candidate) =>
          candidate.to.address === address &&
          !taken.has(candidate.delivery_id) &&
          (template === undefined || candidate.template === template),
      );
      if (job) {
        taken.add(job.delivery_id);
        return job;
      }
      if (Date.now() > deadline) {
        throw new Error(`No ${template ?? 'email'} was queued for ${address}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  return {
    jobs,
    nextJob,
    nextLink: async (address, timeout = 10_000) => {
      const deadline = Date.now() + timeout;
      for (;;) {
        const job = jobs.find(
          (candidate) =>
            candidate.to.address === address &&
            !taken.has(candidate.delivery_id) &&
            typeof candidate.variables['link'] === 'string',
        );
        if (job) {
          taken.add(job.delivery_id);
          return new URL(String(job.variables['link']));
        }
        if (Date.now() > deadline) {
          throw new Error(`No link was queued for ${address}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    },
    stop: async () => {
      await Promise.all(consumers.map((consumer) => consumer.stop()));
    },
  };
}

export async function grantUser(
  db: Kysely<Database>,
  userId: string,
  grants: readonly string[],
): Promise<void> {
  const roleId = randomUUIDv7();
  const now = new Date();
  await db
    .insertInto('roles')
    .values({
      id: roleId,
      slug: `grant_${roleId.replaceAll('-', '')}`,
      name: 'Grant',
      description: 'Grants given directly by a test',
      builtin: false,
      created_at: now,
      updated_at: now,
    })
    .execute();
  if (grants.length > 0) {
    await db
      .insertInto('role_permissions')
      .values(grants.map((permission) => ({ role_id: roleId, permission })))
      .execute();
  }
  await db.insertInto('user_roles').values({ user_id: userId, role_id: roleId }).execute();
}
