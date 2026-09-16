# Database

QTIAuth uses one PostgreSQL database with one schema per service. Each service connects with its own role, and that role can only use its own schema. Services never query each other's schemas. They ask over the bus or keep a local copy fed by events.

| Service    | Schema     | Default role       |
| ---------- | ---------- | ------------------ |
| `identity` | `identity` | `qtiauth_identity` |
| `notifier` | `notify`   | `qtiauth_notify`   |
| `oidc`     | `oidc`     | `qtiauth_oidc`     |
| `safety`   | `safety`   | `qtiauth_safety`   |
| `support`  | `support`  | `qtiauth_support`  |
| `games`    | `games`    | `qtiauth_games`    |

## Connection settings

The `database` section of `qtiauth.yaml` holds the host, database name, TLS mode, pool size and one set of credentials per schema:

```yaml
database:
  host: postgres
  port: 5432
  name: qtiauth
  ssl: disable # disable | require | verify-full
  pool: { max: 10, idle_timeout: 30s, connect_timeout: 10s }
  roles:
    identity: { user: qtiauth_identity, password: '${env:DB_IDENTITY_PASSWORD}' }
    # …one entry per schema
```

Passwords are secrets, so reference them from `.env`. `pool.max` applies to each replica of each service, so the total can reach `pool.max × replicas × services`. Keep it below Postgres's `max_connections`.

## Provisioning roles

Before the first start, and whenever you change a role's name or password, run:

```sh
qtiauth db provision [--config <path>] [--env-file <path>]
```

It connects as the Postgres administrator (`POSTGRES_USER`, default `postgres`, and `POSTGRES_PASSWORD`) and, for every schema:

- creates the role if it's missing, and sets its password, `LOGIN` and no other attributes (not a superuser, can't create databases or roles, doesn't bypass row-level security)
- creates the schema owned by that role, or hands an existing schema to it
- sets the role's default `search_path` to its schema
- grants `CONNECT` on the database

It also revokes the default `PUBLIC` privileges on the database and on the `public` schema, so a role can connect to this database only if it was granted, and can't create objects outside its own schema. Every role needs a non-empty password. The command runs in one transaction and is safe to run again.

## Migrations

### When they run

Each service ships forward-only migrations for its own schema in its image. On startup it takes a Postgres advisory lock for its schema and applies anything pending, so replicas starting together apply each migration exactly once. Upgrading one service's image migrates only that service's schema.

With `migrations.auto_apply: false`, a service with pending migrations refuses to start and prints the command to run:

```
Schema identity has 1 pending migration(s) and migrations.auto_apply is false: 0004_add_display_name
Apply them with:
  docker compose run --rm identity qtiauth migrate up
```

Every service image has:

```sh
qtiauth migrate status   # applied, pending, and migrations applied by a newer release
qtiauth migrate up       # apply pending migrations under the same lock
```

Each migration runs in its own transaction and is recorded in the schema's `schema_migrations` table in the same transaction. If one fails, it's rolled back, later migrations don't run, and the service doesn't start.

An older image can start against a schema that a newer release has already migrated. `migrate status` lists those migrations as `unknown`. This is what makes rolling back an image safe, as long as migrations follow the expand/contract rule below.

---

## For developers

### Connecting

```ts
import { loadConfigOrExit, serviceConfigSchema } from '@qtiauth/config';
import { createDb, loadMigrations, runStartupMigrationsOrExit } from '@qtiauth/db';

const config = await loadConfigOrExit(serviceConfigSchema(['database', 'migrations']));
const db = createDb<Database>(config.database, 'identity');

await runStartupMigrationsOrExit(db, {
  service: 'identity',
  schema: 'identity',
  migrations: await loadMigrations(join(import.meta.dirname, 'migrations')),
  autoApply: config.migrations.auto_apply,
});
```

`createDb` sets the connection's `search_path` to the service's schema, so queries use unqualified table names. `runStartupMigrations` throws a `PendingMigrationsError` instead of exiting.

To add `migrate status|up` to a service's `qtiauth` command, pass `migrateCommands` from `@qtiauth/cli` to `run`:

```ts
import { commands, migrateCommands, run } from '@qtiauth/cli';

const migrations = () => loadMigrations(join(import.meta.dirname, 'migrations'));
await run(argv, io, { ...commands, ...migrateCommands({ schema: 'identity', migrations }) });
```

### Writing a migration

Migrations live in the service's `src/migrations/` directory, one file each, named with a zero-padded sequence number and a short description. They run in name order.

```ts
import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('accounts').addColumn('display_name', 'text').execute();
}
```

- Export only `up`. There are no down migrations. To undo something, write a new migration.
- Don't edit or rename a migration once it's merged. Applied migrations are matched by name.
- A new migration must sort after every migration already on `main`. The runner refuses to apply a pending migration that sorts before an applied one, which catches two branches picking the same or an older number. Renumber yours after rebasing.
- Don't name another schema. The migration runs with `search_path` set to the service's schema, and the role has no rights elsewhere anyway.
- Don't use `Kysely<YourDatabase>` types in migrations. A migration must keep working after the types move on.

### Expand/contract

Every migration must work with both the release that ships it and the previous release of the same service. During a rolling upgrade the old and new code run side by side against the new schema, and an operator may roll the image back without rolling the schema back.

So a breaking change is split across releases. A destructive step ships one release after the code stops using the old shape:

1. Expand (release N): add the new shape alongside the old one, with a migration that's purely additive. New columns are nullable or have a default. The code writes both shapes and reads the new one, falling back to the old one. Backfill the new shape, from a migration if the table is small or from a job if it isn't.
2. Switch (release N+1): the code reads and writes only the new shape. No destructive migration yet, because release N still writes the old shape and might be rolled back to.
3. Contract (release N+2): drop the old shape. Nothing that can still run uses it.

| Change                          | N (expand)                                                       | N+1 (switch)                                        | N+2 (contract)                                        |
| ------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------- |
| Rename a column                 | Add the new column, write both, read new with fallback, backfill | Use only the new column                             | Drop the old column                                   |
| Add a `NOT NULL` column         | Add it nullable, write it everywhere, backfill                   | Add the constraint as `NOT VALID`, then validate it | —                                                     |
| Drop a column or table          | Stop reading and writing it                                      | Drop it                                             | —                                                     |
| Change a column's type          | Add a column with the new type, write both, backfill             | Use only the new column                             | Drop the old column                                   |
| Tighten a constraint            | Make the code satisfy it, fix existing rows                      | Add the constraint as `NOT VALID`, then validate it | —                                                     |
| Split a table                   | Create the new table, write both, backfill                       | Use only the new table                              | Drop the old table or columns                         |
| Change an event's payload shape | Publish `.v2` alongside `.v1`                                    | Keep publishing both                                | Stop publishing `.v1` once every consumer reads `.v2` |

Never safe in one step: dropping or renaming anything the previous release uses, adding `NOT NULL` to a column the previous release doesn't write, and changing a column's type in place.

### Keeping migrations fast

Migrations run while the old release is still serving traffic, so avoid long locks on busy tables:

- Adding a nullable column, or a column with a constant default, is instant. Adding one with a volatile default (such as `now()` or `gen_random_uuid()`) rewrites the table.
- `ALTER TABLE` waits for an exclusive lock and queues everything behind it. Set `lock_timeout` at the start of the migration (`set local lock_timeout = '5s'`) so it fails instead of stalling the service, then retry.
- Backfill large tables in batches outside the migration, not in one `UPDATE`.
- Add constraints as `NOT VALID`, then `VALIDATE CONSTRAINT` in a separate migration. Validating doesn't block writes.

### Tests

`@qtiauth/testing` starts Postgres in a container. Integration tests (`*.integration.test.ts`) should run the service's real migrations against it, connecting with `createDb`.
