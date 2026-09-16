import {
  AckPolicy,
  DeliverPolicy,
  JetStreamApiCodes,
  JetStreamApiError,
  type JetStreamManager,
  RetentionPolicy,
  StorageType,
} from '@nats-io/jetstream';
import { nanos } from '@nats-io/transport-node';
import { EVENT_SOURCES } from '@qtiauth/events';

import type { BusConfig } from './connect.ts';
import { SUBJECT_PREFIX } from './subjects.ts';

export const EVENTS_STREAM = 'QTIAUTH_EVENTS';
export const CRON_STREAM = 'QTIAUTH_CRON';
export const WORK_STREAM = 'QTIAUTH_WORK';

export interface StreamDefinition {
  name: string;
  description: string;
  subjects: string[];
  retention: RetentionPolicy;
  maxAge: number;
}

export interface ConsumerDefinition {
  stream: string;
  name: string;
  subjects: readonly string[];
  startFrom: 'all' | 'new';
  ackWait: number;
  maxDeliver: number;
}

function isApiError(error: unknown, code: number): boolean {
  return error instanceof JetStreamApiError && error.code === code;
}

export function streamDefinitions(config: BusConfig): StreamDefinition[] {
  return [
    {
      name: EVENTS_STREAM,
      description: 'Domain events, published through each service outbox.',
      subjects: EVENT_SOURCES.map((source) => `${SUBJECT_PREFIX}.${source}.>`),
      retention: RetentionPolicy.Limits,
      maxAge: config.streams.events_max_age,
    },
    {
      name: CRON_STREAM,
      description: 'Scheduler ticks. Each owning service consumes its jobs once.',
      subjects: [`${SUBJECT_PREFIX}.sys.cron.>`],
      retention: RetentionPolicy.Interest,
      maxAge: config.streams.work_max_age,
    },
    {
      name: WORK_STREAM,
      description: 'Work queues, such as outgoing email.',
      subjects: [`${SUBJECT_PREFIX}.work.>`],
      retention: RetentionPolicy.Workqueue,
      maxAge: config.streams.work_max_age,
    },
  ];
}

export async function provisionStreams(jsm: JetStreamManager, config: BusConfig): Promise<void> {
  for (const stream of streamDefinitions(config)) {
    const settings = {
      description: stream.description,
      subjects: stream.subjects,
      max_age: nanos(stream.maxAge),
      duplicate_window: nanos(Math.min(config.streams.duplicate_window, stream.maxAge)),
      num_replicas: config.streams.replicas,
    };
    const exists = await jsm.streams.info(stream.name).then(
      () => true,
      (error: unknown) => {
        if (isApiError(error, JetStreamApiCodes.StreamNotFound)) return false;
        throw error;
      },
    );
    if (exists) {
      await jsm.streams.update(stream.name, settings);
    } else {
      await jsm.streams.add({
        name: stream.name,
        retention: stream.retention,
        storage: StorageType.File,
        ...settings,
      });
    }
  }
}

async function consumerExists(jsm: JetStreamManager, stream: string, name: string) {
  return jsm.consumers.info(stream, name).then(
    () => true,
    (error: unknown) => {
      if (isApiError(error, JetStreamApiCodes.ConsumerNotFound)) return false;
      throw error;
    },
  );
}

export async function ensureConsumer(
  jsm: JetStreamManager,
  consumer: ConsumerDefinition,
): Promise<void> {
  const settings = {
    filter_subjects: [...consumer.subjects],
    ack_wait: nanos(consumer.ackWait),
    max_deliver: consumer.maxDeliver,
  };
  if (!(await consumerExists(jsm, consumer.stream, consumer.name))) {
    try {
      await jsm.consumers.add(consumer.stream, {
        durable_name: consumer.name,
        ack_policy: AckPolicy.Explicit,
        deliver_policy: consumer.startFrom === 'all' ? DeliverPolicy.All : DeliverPolicy.New,
        ...settings,
      });
      return;
    } catch (error) {
      if (!(await consumerExists(jsm, consumer.stream, consumer.name))) throw error;
    }
  }
  await jsm.consumers.update(consumer.stream, consumer.name, settings);
}
