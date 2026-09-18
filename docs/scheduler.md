# Scheduler

The scheduler runs jobs on a timetable without doing any of their work. At each job's scheduled time it publishes a tick on `qtiauth.sys.cron.<job>`, and the service that owns the job does the work when the tick arrives. It always runs, and has no database and no public routes.

## Settings

```yaml
scheduler:
  timezone: UTC
  jobs:
    retention.sweep: { schedule: '0 3 * * *', enabled: true }
    keys.rotate: { schedule: '0 0 * * *', enabled: true }
```

- `timezone` is the IANA time zone the schedules are read in, such as `UTC` or `Europe/London`. Outside `UTC`, a job scheduled in an hour that daylight saving time skips runs once the clocks have changed, and one scheduled in an hour that repeats runs once.
- `jobs` sets each job's `schedule` and whether it's `enabled`. Anything you set replaces that part of the built-in job, so `keys.rotate: { enabled: false }` turns off key rotation and keeps its schedule. Jobs you leave out keep their built-in settings.
- A job that isn't built in needs a `schedule`. Its ticks are published whether or not anything consumes them.

Schedules are cron patterns with five fields, `minute hour day-of-month month day-of-week`, or six with seconds first. Each field takes `*`, numbers, ranges (`1-5`), lists (`1,15`) and steps (`*/10`). Months and weekdays can also be names (`JAN`, `MON`). When both day-of-month and day-of-week are set, the job runs on either.

## Jobs

| Job                             | Owner                | Default schedule | Runs             |
| ------------------------------- | -------------------- | ---------------- | ---------------- |
| `retention.sweep`               | every service        | `0 3 * * *`      | daily 03:00      |
| `parental.expire_pending`       | identity             | `0 * * * *`      | hourly           |
| `parental.activity_summary`     | identity             | `0 8 * * 1`      | weekly Mon 08:00 |
| `parental.graduation`           | identity             | `10 0 * * *`     | daily 00:10      |
| `parental.removal_reminders`    | identity             | `0 9 * * 1`      | weekly Mon 09:00 |
| `accounts.purge_deleted`        | identity             | `30 3 * * *`     | daily 03:30      |
| `age.recompute_bands`           | identity             | `5 0 * * *`      | daily 00:05      |
| `accounts.unlock_expired`       | identity             | `* * * * *`      | every minute     |
| `legal.publish`                 | identity             | `* * * * *`      | every minute     |
| `accounts.resume_exports`       | identity             | `*/5 * * * *`    | every 5 min      |
| `deletion_ledger.prune`         | identity             | `0 4 * * *`      | daily 04:00      |
| `keys.rotate`                   | gateway, oidc, games | `0 0 * * *`      | daily 00:00      |
| `webhooks.retry`                | notifier             | `* * * * *`      | every minute     |
| `support.auto_close`            | support              | `0 * * * *`      | hourly           |
| `achievements.recompute_rarity` | games                | `0 2 * * *`      | daily 02:00      |
| `leaderboards.reset_periodic`   | games                | `* * * * *`      | every minute     |
| `steam.ownership_sync`          | games                | `0 5 * * *`      | daily 05:00      |
| `backup.run`                    | backup               | `30 2 * * *`     | daily 02:30      |

`keys.rotate` only replaces a key once it's due, and `leaderboards.reset_periodic` only resets leaderboards whose period has ended, so ticking often costs little. A job whose owning service isn't running is ticked anyway, and the tick is thrown away.

To see every job and when it next runs with your config:

```sh
docker compose run --rm scheduler qtiauth jobs list
```

## How ticks are delivered

- **Once per owning service.** Replicas of a service share one durable consumer for each job, so only one replica runs each tick. When several services own a job, such as `retention.sweep`, each of them runs it once.
- **More than one scheduler is safe.** Each tick carries the job name and its scheduled time as its message ID (`<job>@<scheduled time>`), and JetStream drops the copy a second scheduler publishes. Run two schedulers if a job mustn't be missed while one restarts.
- **Failed runs are retried.** If a service's run fails, the tick is delivered again with the same backoff as any other message (see [bus.md](bus.md#delivery-guarantees)). Jobs should be safe to run again.
- **Failed publishes are retried,** from `bus.consumers.retry_delay` up to `max_retry_delay`, for as long as `bus.streams.duplicate_window` and never past the job's next tick. Retrying any longer could run the job twice, so after that the tick is dropped and logged.
- **Missed ticks aren't caught up.** Ticks due while the scheduler was stopped are skipped, and so are ticks that pass while a publish is still being retried. The next tick runs as normal.
- A tick's `scheduled_at` is the time it was due, not when it was published, so a job can work out what period it covers.

## Metrics

| Metric                                          | Labels                | Reported by        |
| ----------------------------------------------- | --------------------- | ------------------ |
| `qtiauth_scheduler_ticks_total`                 | `cron_job`, `outcome` | scheduler          |
| `qtiauth_scheduler_publish_failures_total`      | `cron_job`            | scheduler          |
| `qtiauth_scheduler_next_tick_timestamp_seconds` | `cron_job`            | scheduler          |
| `qtiauth_cron_runs_total`                       | `cron_job`, `outcome` | the owning service |
| `qtiauth_cron_run_duration_seconds`             | `cron_job`, `outcome` | the owning service |

A tick's `outcome` is `published`, or `dropped` when publishing failed until it had to give up. A run's `outcome` is `succeeded` or `failed`. A failed run is retried, so it can be counted more than once for one tick. The label is `cron_job` rather than `job`, because Prometheus sets `job` itself.

Alert on any `dropped` tick, and on runs that keep failing.

---

## For developers

### Owning a job

Consume the job's ticks in the service that does the work, passing the service's bus metrics so runs are reported:

```ts
import { consumeCron } from '@qtiauth/bus';

const sweep = await consumeCron(ctx.bus, {
  job: 'retention.sweep',
  metrics: ctx.busMetrics,
  handler: async (tick) => sweepExpired(ctx.db, new Date(tick.data.scheduled_at)),
  onError: (error) => ctx.log.error('retention sweep failed', { error }),
});
```

Return it from `start` so it stops with the service. The consumer is named `<service>-cron-<job>`. Ticks published while no service has a consumer for the job are thrown away. Handlers can be run again for the same tick, so make them idempotent.

A new job needs a default schedule in `DEFAULT_CRON_JOBS` in `packages/config/src/sections.ts`, a row in the table above and in [SPEC §2.8](../SPEC.md#28-scheduler), and the same entry in `config/qtiauth.yaml`.

### Tests

`startScheduler` from `services/scheduler/src/scheduler.ts` takes the jobs and a `publish` function, so the timetable can be tested with fake timers and no NATS. For consumers, publish a tick yourself with `publishCronTick(bus.js, job, scheduledAt)`.
