---
'@qtiauth/scheduler': minor
'@qtiauth/bus': minor
'@qtiauth/config': minor
'@qtiauth/testing': patch
---

Add the scheduler service, which publishes `qtiauth.sys.cron.<job>` ticks on cron schedules from the new `scheduler` config section, retries failed publishes without duplicating ticks, reports tick metrics and lists jobs with `qtiauth jobs list`. `consumeCron` in `@qtiauth/bus` now reports each run's outcome and duration. The Compose stack now builds and runs the scheduler.
