# Observability

Every service writes structured JSON logs, creates OpenTelemetry traces, serves Prometheus metrics and answers health checks.

## Settings

The `observability` section of `qtiauth.yaml`:

```yaml
observability:
  logs:
    level: info
    user_id_hash_key: '${env:LOG_USER_ID_HASH_KEY}'
    redact_keys: []
  tracing: { enabled: false, endpoint: 'http://tempo:4318/v1/traces', sample_ratio: 1 }
  metrics: { process_metrics: true }
  health: { check_timeout: 2s }
```

## Logs

Services write one JSON object per line to standard output:

```json
{
  "time": "2026-09-16T12:00:00.000Z",
  "level": "warn",
  "service": "identity",
  "message": "password sign-in failed",
  "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
  "span_id": "00f067aa0ba902b7",
  "request_id": "…",
  "user_id": "9c56cc51b374c3ba189210d5b6d4bf57"
}
```

Levels are `trace`, `debug`, `info`, `warn`, `error` and `fatal`. Records below `logs.level` are skipped.

- **User IDs are hashed** with `logs.user_id_hash_key`. Use the same key on every service, so you can follow one user's activity across services without their ID appearing in logs. Changing the key breaks that link for older logs.
- **Secrets are never written.** Any field whose name ends in `password`, `passphrase`, `secret`, `token`, `tokens`, `authorization`, `cookie`, `apikey`, `privatekey`, `credentials`, `otp`, `totpcode`, `recoverycode`, `recoverycodes`, `steamticket`, `reportcontent`, `emailbody`, `filterinput`, `signature` or `captcha` is written as `[REDACTED]`, however deeply it's nested. Names are compared without case, `_` or `-`, so `refresh_token`, `refreshToken` and `Set-Cookie` all match. Add your own names with `logs.redact_keys`.

## Traces

Traces follow a request from the gateway through each service, its database queries and the bus, to the services that consume the events it caused. An event relayed from the outbox after the request finished still joins that request's trace.

Trace IDs are always created and passed between services, and every log line written during a request carries its `trace_id`. Set `tracing.enabled: true` to also send spans to an OTLP/HTTP collector at `tracing.endpoint`, such as Tempo in the `observability` profile.

`tracing.sample_ratio` keeps that share of traces. Services decide from the trace ID, so every service keeps or drops the same traces as long as they all use the same ratio.

Spans record the route template (`/api/v1/users/:id`), never the full URL, and parameterised SQL, never query values. A failed span records the error's type, not its message.

## Metrics

Each service serves Prometheus metrics on `/metrics` on the internal network. Every metric is named `qtiauth_…` and has a `service` label. With `metrics.process_metrics`, Node.js CPU, memory, event loop and garbage collection metrics are included too.

The gateway's request, rate-limit, session and key metrics are listed in [gateway.md](gateway.md#metrics), the scheduler's tick and job run metrics in [scheduler.md](scheduler.md#metrics), the notifier's email and webhook metrics in [notifier.md](notifier.md#metrics), and identity's sign-in, session and account metrics in [identity.md](identity.md#metrics).

Labels never hold unbounded values. A service refuses to start if it defines a metric with a label named `id`, anything ending in `_id`, or `user`, `username`, `email`, `ip`, `ip_address`, `address`, `session`, `token`, `url`, `path`, `query` or `user_agent`.

## Health

| Endpoint   | Answers                                                                 |
| ---------- | ----------------------------------------------------------------------- |
| `/healthz` | `200` while the process is running. Use it for liveness probes.         |
| `/readyz`  | `200` when every dependency (database, NATS, Valkey) responds, or `503` |

```json
{
  "status": "unavailable",
  "service": "identity",
  "checks": {
    "database": { "status": "ok", "duration_ms": 3 },
    "nats": { "status": "timeout", "duration_ms": 2000 }
  }
}
```

A check that takes longer than `health.check_timeout` counts as `timeout`. Error messages aren't included in the response, because they can contain connection details. Health checks aren't traced.

---

## For developers

### Logging

```ts
import { createLogger } from '@qtiauth/observability';

const log = createLogger({ service: 'identity', config: config.observability.logs });

const requestLog = log.child({ request_id: requestId, user_id: userId });
requestLog.warn('password sign-in failed', { method: 'password', error });
```

- Put identifiers in `user_id` so they're hashed. Only the top-level `user_id` field is hashed.
- Name fields for what they hold (`magic_link_token`, not `value`), so redaction can recognise them. Redaction works on names, not values, and error messages are logged as they are, so don't put secrets in them.
- Fields can't overwrite `time`, `level`, `service`, `message`, `trace_id` or `span_id`.

### Tests for logs

Every feature has a log-scrubbing test that runs it with known secrets and checks none of them reach the logs:

```ts
import { createLogger } from '@qtiauth/observability';
import { assertLogsScrubbed, captureLogs } from '@qtiauth/observability/testing';

const logs = captureLogs();
const log = createLogger({ service: 'identity', config, destination: logs.destination });

await signIn({ log, email, password: 'correct horse battery staple' });
assertLogsScrubbed(logs.lines, ['correct horse battery staple', userId]);
```

`assertLogsScrubbed` also finds secrets as they appear after JSON escaping, and its error names the line without repeating the secret.

### Tracing

Start tracing before anything else, and shut it down last so the final spans are sent:

```ts
import { startTracing } from '@qtiauth/observability';

const tracing = startTracing(config.observability.tracing, 'identity');
await tracing.shutdown();
```

What's traced for you:

- **Database:** `createDb` traces every query as a child of the active span.
- **Bus:** publishing, consuming and request/reply (see [bus.md](bus.md#tracing)).
- **HTTP:** wrap each incoming request in `traceHttpRequest(request, route, handler)`, which continues the caller's trace. Use `tracedFetch` for outgoing calls.

For anything else, `withSpan(name, options, fn)` runs `fn` inside a new span and marks it failed if `fn` throws. `untraced(fn)` runs `fn` without creating spans, for background polling that would otherwise start a trace every few seconds.

In tests, `startTestTracing()` from `@qtiauth/observability/testing` keeps finished spans in memory:

```ts
const tracing = startTestTracing();
await banUser(userId);
expect(tracing.spans().map((span) => span.name)).toContain('send qtiauth.identity.user.banned.v1');
await tracing.shutdown();
```

### Metrics

```ts
import { createMetrics, metricsResponse } from '@qtiauth/observability';
import { prometheusBusMetrics } from '@qtiauth/bus';

const metrics = createMetrics(config.observability.metrics, 'identity');
const signIns = metrics.counter({
  name: 'qtiauth_auth_sign_ins_total',
  help: 'Sign-ins by method and result.',
  labelNames: ['method', 'result'],
});
signIns.inc({ method: 'password', result: 'success' });

const busMetrics = prometheusBusMetrics(metrics);
const response = await metricsResponse(metrics);
```

`counter`, `gauge` and `histogram` throw `MetricDefinitionError` for a badly named metric or a forbidden label, so a mistake fails the service's tests rather than production.

### Health

```ts
import { busHealthCheck } from '@qtiauth/bus';
import { databaseHealthCheck } from '@qtiauth/db';
import { healthResponse, liveness, readiness } from '@qtiauth/observability';

healthResponse(liveness('identity'));

healthResponse(
  await readiness(
    'identity',
    { database: databaseHealthCheck(db), nats: busHealthCheck(bus) },
    {
      timeout: config.observability.health.check_timeout,
      onError: (check, error) => log.warn(`${check} check failed`, { error }),
    },
  ),
);
```

A check is any `() => Promise<void>` that throws when the dependency is unavailable.
