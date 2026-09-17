# Message bus

Services talk to each other over NATS with JetStream. There are four kinds of traffic:

| Kind          | Subject                                  | Delivery                                                   |
| ------------- | ---------------------------------------- | ---------------------------------------------------------- |
| Domain events | `qtiauth.<service>.<entity>.<verb>.v<n>` | Durable, at least once, published through a service outbox |
| Cron ticks    | `qtiauth.sys.cron.<job>`                 | Durable, once per owning service                           |
| Work queues   | `qtiauth.work.<service>.<queue>`         | Durable, once per job                                      |
| Request/reply | `qtiauth.rpc.<service>.<method>`         | Not stored. Fails straight away if nobody is listening     |

## Connection settings

The `bus` section of `qtiauth.yaml`:

```yaml
bus:
  servers: [nats://nats:4222]
  user: null
  password: '${env:NATS_PASSWORD}'
  tls: { required: false, ca_file: null }
  connect_timeout: 10s
  request_timeout: 5s
  streams: { replicas: 1, events_max_age: 7d, work_max_age: 7d, duplicate_window: 2m }
  outbox: { poll_interval: 1s, batch_size: 100, sent_retention: 1d }
  consumers:
    ack_wait: 30s
    max_deliver: 10
    retry_delay: 1s
    max_retry_delay: 5m
    dedupe_retention: 14d
```

TLS is used whenever the server offers it. Set `tls.required: true` to refuse a plaintext connection, or `tls.ca_file` to verify the server against a private CA. A service keeps trying to reconnect for as long as it runs.

## Streams

Services create or update these streams when they start, so there's nothing to provision by hand:

| Stream           | Subjects                                   | Retention                                                 |
| ---------------- | ------------------------------------------ | --------------------------------------------------------- |
| `QTIAUTH_EVENTS` | `qtiauth.<source>.>` for each event source | Kept for `streams.events_max_age`, read by many consumers |
| `QTIAUTH_CRON`   | `qtiauth.sys.cron.>`                       | Removed once every owning service has handled the tick    |
| `QTIAUTH_WORK`   | `qtiauth.work.>`                           | Removed once a consumer has handled the job               |

Event sources are `identity`, `notifier`, `oidc`, `safety`, `support`, `games` and `audit`. Cron ticks and jobs nobody takes are dropped after `streams.work_max_age`. On a NATS cluster, set `streams.replicas: 3`.

JetStream drops a message whose ID it has already seen within `streams.duplicate_window`. Events use their `event_id` as the message ID and cron ticks use `<job>@<scheduled time>`, so a retried publish or a second scheduler replica doesn't create a duplicate.

## Delivery guarantees

No event is lost. A service writes an event to its `outbox` table in the same transaction as the change it describes. A relay in each replica publishes unsent events in order and marks them sent. If the service dies after committing, the next replica to start publishes the event. If it dies after publishing but before marking the row, the event is published again and JetStream drops the duplicate.

No event is applied twice. Each consumer records the `event_id` in its service's `processed_events` table in the same transaction as its own changes, and skips events it has already recorded. Keep `consumers.dedupe_retention` at least as long as `streams.events_max_age`, since anything still in the stream could be delivered again.

Failed messages are retried. When handling a message fails, it's retried after `retry_delay`, doubling each time up to `max_retry_delay`, for up to `max_deliver` attempts. After that it stays in the stream but isn't delivered again. A message that isn't valid JSON or doesn't match its schema is dropped straight away instead. Replicas of a service share one durable consumer, so each message goes to one replica.

Request/reply fails fast. Every request carries a deadline (`request_timeout` unless the caller sets one). If the target service isn't running, the caller hears straight away rather than waiting for the deadline, and has to handle that case.

## Cleaning up

Sent outbox rows are kept for `outbox.sent_retention` and processed event IDs for `consumers.dedupe_retention`. Each service deletes older rows in its `retention.sweep` job.

## Metrics

The bus reports publishes and publish failures per subject, consumed messages per consumer and outcome (`processed`, `duplicate`, `failed`, `rejected`), redeliveries, consumer lag, outbox backlog size and oldest unsent age, request/reply latency by outcome (`ok`, `error`, `timeout`, `no_responders`), and cron job runs and their duration by outcome (`succeeded`, `failed`). Watch the outbox's oldest unsent age: a growing value means a service can't reach NATS.

Pass `prometheusBusMetrics(metrics)` as `metrics` to report these to Prometheus (see [observability.md](observability.md)).

## Tracing

Publishing, consuming and request/reply each create a span, and pass the trace on in a `traceparent` message header. Events also store `trace_id` and `span_id` in their envelope, so an event relayed from the outbox later still belongs to the trace of the request that wrote it. The relay's own polling isn't traced.

---

## For developers

### Connecting

```ts
import { connectBus, provisionStreams } from '@qtiauth/bus';

const config = await loadConfigOrExit(serviceConfigSchema(['database', 'migrations', 'bus']));
const bus = await connectBus(config.bus, 'identity');
await provisionStreams(bus.jsm, config.bus);
```

`bus.close()` drains the connection, so in-flight messages finish first.

### Bus tables

Every service with a database needs the outbox and dedupe tables. Add a migration that runs `createBusTablesV1`:

```ts
export { createBusTablesV1 as up } from '@qtiauth/bus';
```

`createBusTablesV1` never changes. A later change to these tables ships as a new function for a new migration.

### Publishing events

Write the event inside the transaction that makes the change. Nothing is published if the transaction rolls back.

```ts
import { startOutboxRelay, writeEvent } from '@qtiauth/bus';

const relay = startOutboxRelay(bus, db, { onError: (error) => log.error(error), metrics });

await db.transaction().execute(async (trx) => {
  await trx.updateTable('users').set({ state: 'banned' }).where('id', '=', userId).execute();
  await writeEvent(trx, {
    type: 'qtiauth.identity.user.banned.v1',
    actor: { type: 'user', id: staffId },
    subject: { type: 'user', id: userId },
    data: { reason },
  });
});
relay.wake();
```

`writeEvent` fills in `event_id` (a ULID), `occurred_at`, and `trace_id` and `span_id` from the active span, checks the envelope, and throws if it isn't called inside a transaction. Start one relay per replica, and stop it on shutdown with `await relay.stop()`. It polls every `outbox.poll_interval`, and `wake()` publishes straight away. Only one replica relays a schema's outbox at a time, which keeps events in order.

### Consuming events

```ts
import { consumeEvents } from '@qtiauth/bus';

const consumer = await consumeEvents(bus, db, {
  name: 'user-deleted',
  types: ['qtiauth.identity.user.deleted.v1'],
  catalog,
  handler: async (event, trx) => {
    await eraseTickets(trx, event);
  },
  onError: (error, message) => log.error(error, message),
});
await consumer.stop();
```

- Do the handler's database work through `trx`. It commits together with the dedupe record, and a throw rolls both back and retries the event.
- Anything outside the database, such as sending email, can still run twice if the service dies between doing it and committing. Queue it as a work job, or make it idempotent itself.
- The durable consumer is named `<service>-<name>`. A new consumer starts with events published after it's created. Pass `startFrom: 'all'` to also read what's still in the stream, for example to build a read-model.
- Pass `catalog` (from `loadEventCatalog`) to check each event's data against its schema.

A service without a database, or a handler that's safe to run twice, can use `consumeIdempotentEvents(bus, { name, types, handler, onError })` instead. Its handler takes just the event and nothing records what was processed, so a redelivered event runs the handler again. The gateway uses it to clear cached sessions.

### Work queues and cron

```ts
import { consumeCron, consumeWork, publishWork, workSubject } from '@qtiauth/bus';

await publishWork(bus.js, workSubject('notifier', 'email'), message, { id: messageId });

await consumeWork<EmailMessage>(bus, {
  queue: 'email',
  handler: async (job) => send(job.data),
  onError,
});

await consumeCron(bus, {
  job: 'retention.sweep',
  handler: async (tick) => sweep(new Date(tick.data.scheduled_at)),
  onError,
});
```

A service consumes only its own queues. Jobs that run longer than `ack_wait` are kept alive automatically. Pass `retry: { max_deliver, retry_delay, max_retry_delay }` to give a consumer its own retries instead of the `consumers` settings, as the notifier does so email is retried for hours. `publishCronTick(bus.js, job, scheduledAt)` is what the scheduler publishes, and `consumeCron` reports each run's outcome and duration through `metrics` (see [scheduler.md](scheduler.md)).

### Request/reply

```ts
import { RpcError, rpcRequest, serveRpc } from '@qtiauth/bus';

serveRpc(bus, {
  method: 'get_user_summary',
  handler: async ({ user_id }, { deadline }) => {
    const user = await findUser(user_id);
    if (!user) throw new RpcError('not_found', 'No such user');
    return summarize(user);
  },
  onError,
});

const result = await rpcRequest<Summary>(bus, 'identity', 'get_user_summary', { user_id });
switch (result.status) {
  case 'ok': // result.data
  case 'error': // result.code, result.message
  case 'no_responders': // the service isn't running
  case 'timeout':
}
```

Throw `RpcError` for errors the caller should see. Any other error is reported to `onError` and the caller gets `internal`, without the message. A request that arrives after its deadline is dropped.

### Event schemas

Each event type has a JSON Schema (draft 2020-12) for its `data`, in `packages/events/schemas/<service>/<entity>.<verb>.v<n>.json`, with `"$id": "urn:qtiauth:event:<type>"`. The envelope's schema is `packages/events/schemas/envelope.json`. `loadEventCatalog()` loads them all and refuses a file whose path or `$id` doesn't match its type.

Versioning:

- Adding an optional field is compatible, so it stays in the same version. Consumers must ignore fields they don't know.
- Anything else (removing or renaming a field, changing its type or meaning, making it required) is a new version. Add `<name>.v<n+1>.json` and publish both versions for at least one release, then stop publishing the old one once every consumer reads the new one (see [expand/contract](database.md#expandcontract)).
- Never edit a published schema in an incompatible way.

### Tests

Contract tests check that what a producer writes matches its schema:

```ts
import { checkOutboxContract } from '@qtiauth/bus/testing';
import { loadEventCatalog } from '@qtiauth/events';

await banUser(db, userId);
const [event] = await checkOutboxContract(db, await loadEventCatalog());
expect(event.type).toBe('qtiauth.identity.user.banned.v1');
```

`@qtiauth/testing` starts NATS with JetStream. Use `natsUrl(container)` for `bus.servers`, and shorten `consumers.retry_delay` so retries don't slow the tests down.
