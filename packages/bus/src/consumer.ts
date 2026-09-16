import type { JsMsg } from '@nats-io/jetstream';

import type { Bus, BusConfig } from './connect.ts';
import { type BusMetrics, type ConsumeOutcome, noopBusMetrics } from './metrics.ts';
import { ensureConsumer } from './streams.ts';

export interface MessageContext {
  consumer: string;
  subject: string;
  attempt: number;
}

export interface ConsumerOptions {
  onError: (error: unknown, message: MessageContext) => void;
  metrics?: BusMetrics;
}

export interface RunningConsumer {
  name: string;
  stop: () => Promise<void>;
}

export interface PullConsumerOptions extends ConsumerOptions {
  stream: string;
  name: string;
  subjects: readonly string[];
  startFrom: 'all' | 'new';
  handle: (msg: JsMsg) => Promise<Exclude<ConsumeOutcome, 'failed' | 'rejected'>>;
}

export class InvalidMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMessageError';
  }
}

const BATCH_SIZE = 10;

export function retryDelay(attempt: number, consumers: BusConfig['consumers']): number {
  const delay = consumers.retry_delay * 2 ** Math.max(0, attempt - 1);
  return Math.min(delay, consumers.max_retry_delay);
}

export async function runPullConsumer(
  bus: Bus,
  options: PullConsumerOptions,
): Promise<RunningConsumer> {
  const { consumers } = bus.config;
  const metrics = options.metrics ?? noopBusMetrics;
  await ensureConsumer(bus.jsm, {
    stream: options.stream,
    name: options.name,
    subjects: options.subjects,
    startFrom: options.startFrom,
    ackWait: consumers.ack_wait,
    maxDeliver: consumers.max_deliver,
  });
  const consumer = await bus.js.consumers.get(options.stream, options.name);
  const messages = await consumer.consume({ max_messages: BATCH_SIZE });

  const handle = async (msg: JsMsg): Promise<void> => {
    const context = {
      consumer: options.name,
      subject: msg.subject,
      attempt: msg.info.deliveryCount,
    };
    if (msg.redelivered) metrics.redelivered(options.name, msg.subject);
    metrics.consumerLag(options.name, msg.info.pending);

    const heartbeat = setInterval(
      () => {
        msg.working();
      },
      Math.max(consumers.ack_wait / 2, 1),
    );
    let outcome: ConsumeOutcome;
    try {
      outcome = await options.handle(msg);
      msg.ack();
    } catch (error) {
      if (error instanceof InvalidMessageError) {
        outcome = 'rejected';
        msg.term(error.message);
      } else {
        outcome = 'failed';
        msg.nak(retryDelay(context.attempt, consumers));
      }
      options.onError(error, context);
    } finally {
      clearInterval(heartbeat);
    }
    metrics.consumed(options.name, msg.subject, outcome);
  };

  const done = (async () => {
    for await (const msg of messages) await handle(msg);
  })();

  return {
    name: options.name,
    stop: async () => {
      await messages.close();
      await done;
    },
  };
}

export function parseJson(msg: JsMsg): unknown {
  try {
    return JSON.parse(msg.string());
  } catch {
    throw new InvalidMessageError(`Message on ${msg.subject} isn't valid JSON`);
  }
}
