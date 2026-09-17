import { type Bus, consumeWork } from '@qtiauth/bus';
import { type EmailJob, emailQueue } from '@qtiauth/email';

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
    stop: () => consumer.stop(),
  };
}
