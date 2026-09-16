import { type JetStreamClient, PubHeaders } from '@nats-io/jetstream';

import type { Bus } from './connect.ts';
import {
  type ConsumerOptions,
  parseJson,
  type RunningConsumer,
  runPullConsumer,
} from './consumer.ts';
import { CRON_STREAM, WORK_STREAM } from './streams.ts';
import { consumerName, cronSubject, workSubject } from './subjects.ts';

export interface WorkMessage<T> {
  subject: string;
  data: T;
  attempt: number;
  id: string | null;
}

export interface CronTick {
  job: string;
  scheduled_at: string;
}

export interface WorkConsumerOptions<T> extends ConsumerOptions {
  queue: string;
  handler: (job: WorkMessage<T>) => Promise<void>;
}

export interface CronConsumerOptions extends ConsumerOptions {
  job: string;
  handler: (tick: WorkMessage<CronTick>) => Promise<void>;
}

export async function publishWork(
  js: JetStreamClient,
  subject: string,
  data: unknown,
  options: { id?: string } = {},
): Promise<void> {
  await js.publish(
    subject,
    JSON.stringify(data),
    options.id === undefined ? {} : { msgID: options.id },
  );
}

export async function publishCronTick(
  js: JetStreamClient,
  job: string,
  scheduledAt: Date,
): Promise<void> {
  const tick: CronTick = { job, scheduled_at: scheduledAt.toISOString() };
  await publishWork(js, cronSubject(job), tick, { id: `${job}@${tick.scheduled_at}` });
}

function consumeJobs<T>(
  bus: Bus,
  options: ConsumerOptions & {
    stream: string;
    name: string;
    subject: string;
    handler: (job: WorkMessage<T>) => Promise<void>;
  },
): Promise<RunningConsumer> {
  return runPullConsumer(bus, {
    ...options,
    subjects: [options.subject],
    startFrom: 'all',
    handle: async (msg) => {
      await options.handler({
        subject: msg.subject,
        data: parseJson(msg) as T,
        attempt: msg.info.deliveryCount,
        id: msg.headers?.has(PubHeaders.MsgIdHdr) ? msg.headers.get(PubHeaders.MsgIdHdr) : null,
      });
      return 'processed';
    },
  });
}

export function consumeWork<T>(
  bus: Bus,
  options: WorkConsumerOptions<T>,
): Promise<RunningConsumer> {
  return consumeJobs(bus, {
    ...options,
    stream: WORK_STREAM,
    name: consumerName(bus.service, 'work', options.queue),
    subject: workSubject(bus.service, options.queue),
  });
}

export function consumeCron(bus: Bus, options: CronConsumerOptions): Promise<RunningConsumer> {
  return consumeJobs(bus, {
    ...options,
    stream: CRON_STREAM,
    name: consumerName(bus.service, 'cron', options.job),
    subject: cronSubject(options.job),
  });
}
