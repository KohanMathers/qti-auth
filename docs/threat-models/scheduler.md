# Threat model: scheduler

The scheduler publishes cron ticks on `qtiauth.sys.cron.<job>`. It holds no
job logic, no database, and no public routes. Each service consumes the ticks
for the jobs it owns. See [../scheduler.md](../scheduler.md) for the working
model.

## Assets

- **The cron schedules** in config.
- **JetStream deduplication headers** that stop several scheduler replicas
  publishing the same tick twice.

## Trust boundaries

- **Config → scheduler.** Trusted; comes from `qtiauth.yaml`.
- **Scheduler → NATS.** Internal network only.

## Threats

- **Duplicate ticks.** Each tick uses `<job>@<scheduled_at>` as its JetStream
  message ID, so replicas dedupe.
- **Skipped ticks.** Ticks due while the scheduler is down are not caught up;
  operator runbooks call this out and each job is idempotent by design.
- **Config-driven overload.** A too-frequent schedule can flood a service.
  The job owner's consumer is a JetStream work-queue with a bounded pending
  window; excess ticks queue rather than fan out.
- **Unauthorized job addition.** Adding a job requires editing `qtiauth.yaml`
  which is a config change under operator control.

## Mitigations

- No public exposure; scheduler doesn't accept requests.
- Non-root, read-only container.

## Open questions

- Should the scheduler emit a metric when it skips a tick due to being down?
