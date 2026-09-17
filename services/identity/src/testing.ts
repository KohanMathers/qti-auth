import { type Bus, consumeWork } from '@qtiauth/bus';
import { type EmailJob, emailQueue } from '@qtiauth/email';

export interface CapturedEmails {
  jobs: EmailJob[];
  nextLink: (address: string, timeout?: number) => Promise<URL>;
  stop: () => Promise<void>;
}

export async function captureEmails(bus: Bus): Promise<CapturedEmails> {
  if (bus.service !== 'notifier') {
    throw new Error('Capture email from a bus connected as notifier');
  }
  const jobs: EmailJob[] = [];
  const taken = new Set<string>();
  const consumer = await consumeWork<EmailJob>(bus, {
    queue: emailQueue('high'),
    handler: (message) => {
      jobs.push(message.data);
      return Promise.resolve();
    },
    onError: () => undefined,
  });

  return {
    jobs,
    nextLink: async (address, timeout = 10_000) => {
      const deadline = Date.now() + timeout;
      for (;;) {
        const job = jobs.find((j) => j.to.address === address && !taken.has(j.delivery_id));
        if (job) {
          taken.add(job.delivery_id);
          return new URL(String(job.variables['link']));
        }
        if (Date.now() > deadline) throw new Error(`No magic link was queued for ${address}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    },
    stop: () => consumer.stop(),
  };
}
