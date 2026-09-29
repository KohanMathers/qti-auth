# Services

Every QTIAuth service is built on `@qtiauth/service-kit`, so they all start, stop, check requests and report errors the same way.

## Settings

The `service` section of `qtiauth.yaml` applies to every service:

```yaml
service:
  http: { port: 8080, shutdown_timeout: 15s }
  identity_tokens: { clock_tolerance: 5s, keys_refresh: 5m }
```

- `http.port` is the port each service listens on inside the internal network. Only the gateway publishes a port.
- `http.shutdown_timeout` is how long a service waits for in-flight requests on `SIGTERM` or `SIGINT` before closing their connections. Give your orchestrator's stop grace period a little more than twice this, since background work is stopped after requests.
- `identity_tokens.clock_tolerance` allows for clock differences between the gateway and a service. Keep hosts in sync with NTP rather than raising it.
- `identity_tokens.keys_refresh` is how often a service fetches the gateway's public keys.

## Starting and stopping

When a service starts it:

1. Loads and checks its sections of `qtiauth.yaml`, and refuses to start if they're invalid.
2. Applies its database migrations, or refuses to start if `migrations.auto_apply` is `false` and some are pending (see [database.md](database.md)).
3. Connects to NATS and creates or updates the streams (see [bus.md](bus.md)).
4. Starts its outbox relay, consumers and anything else it runs in the background.
5. Starts listening, then announces itself and its routes to the gateway.

On `SIGTERM` or `SIGINT` it reports not ready on `/readyz`, stops announcing, finishes in-flight requests, stops background work, drains its NATS connection and closes its database pool. It exits with status 0 when that completes, or 1 if it takes more than twice `http.shutdown_timeout`.

A service that fails to start logs a `fatal` line saying why and exits with status 1.

## Internal endpoints

These are served on `http.port` and are never routed by the gateway:

| Endpoint        | Answers                                                             |
| --------------- | ------------------------------------------------------------------- |
| `/healthz`      | Liveness (see [observability.md](observability.md#health))          |
| `/readyz`       | Readiness: NATS, the database if the service has one, and any extra |
| `/metrics`      | Prometheus metrics                                                  |
| `/openapi.json` | The service's OpenAPI 3.1 document                                  |

Every service also records `qtiauth_http_requests_total` and `qtiauth_http_request_duration_seconds` by method, route template and status, and `qtiauth_http_identity_rejections_total` by reason.

## Internal identity tokens

Services never read cookies or bearer tokens. The gateway resolves the caller and sends every request on with a 60-second EdDSA token in `X-QTIAuth-Identity`, minted for that one service. A service refuses any request without a valid token, including requests to routes that need no sign-in.

Services fetch the gateway's public keys over `qtiauth.rpc.gateway.identity_keys` (see [gateway.md](gateway.md#internal-identity-keys)). They keep using the keys they have if a refresh fails, so a gateway restart doesn't interrupt anything. Until a service has fetched keys at least once, requests get `503 SERVICE_UNAVAILABLE`.

As well as the gateway's checks, each service checks the route's auth mode, permissions, OAuth scopes and allowed account states against the token.

## Route manifests and discovery

A service announces itself on `qtiauth.sys.announce` when it starts, and again whenever anything publishes `qtiauth.sys.discover`. The announcement carries the service name, version, a per-process `instance_id` and its route manifest: every route's method, path, module and policy, plus the permissions the service defines and the notification categories it registers. The gateway builds its route table from these, so a service that isn't running has no routes (see [gateway.md](gateway.md#surfaces-and-route-tables)).

Print a service's manifest or OpenAPI document without starting it:

```sh
docker compose run --rm identity qtiauth routes manifest
docker compose run --rm identity qtiauth routes openapi
```

## Errors

Every error response is RFC 9457 Problem Details with `content-type: application/problem+json`:

```json
{
  "type": "urn:qtiauth:problem:VALIDATION_FAILED",
  "title": "The request is not valid",
  "status": 400,
  "code": "VALIDATION_FAILED",
  "request_id": "0b6f…",
  "errors": [{ "location": "body", "path": "email", "code": "invalid_format", "message": "…" }]
}
```

Clients branch on `code`. `title` and `detail` are for developers, not users. Unexpected errors are logged and returned as `500 INTERNAL_ERROR` without their message.

Codes every service can return:

| Code                        | Status | When                                                                           |
| --------------------------- | ------ | ------------------------------------------------------------------------------ |
| `VALIDATION_FAILED`         | 400    | Path, query or body doesn't match the route's schema                           |
| `INVALID_JSON`              | 400    | The body isn't JSON                                                            |
| `INVALID_CURSOR`            | 400    | A pagination cursor was changed or belongs to another list                     |
| `IDENTITY_TOKEN_INVALID`    | 401    | The internal identity token is missing, forged, expired or for another service |
| `AUTH_MODE_NOT_ALLOWED`     | 401    | The caller authenticated in a way the route doesn't accept                     |
| `PERMISSION_DENIED`         | 403    | A required permission is missing                                               |
| `INSUFFICIENT_SCOPE`        | 403    | A required OAuth scope is missing (`missing_scopes` lists them)                |
| `ACCOUNT_STATE_NOT_ALLOWED` | 403    | The route doesn't allow the account's state                                    |
| `NOT_FOUND`                 | 404    | No such route                                                                  |
| `UNSUPPORTED_MEDIA_TYPE`    | 415    | The body isn't `application/json`                                              |
| `INTERNAL_ERROR`            | 500    | Anything unexpected                                                            |
| `SERVICE_UNAVAILABLE`       | 503    | The gateway's keys can't be fetched                                            |

Each service's OpenAPI document lists its own codes under `x-qtiauth-errors`, and every operation lists the codes it can return by status.

## Pagination

Lists that can grow take `limit` and `cursor` query parameters and answer:

```json
{ "items": [], "next_cursor": "eyJpZCI6…" }
```

Pass `next_cursor` back as `cursor` for the next page. It's `null` on the last page. Treat cursors as opaque.

## Data rights

Every service that stores personal data answers `qtiauth.rpc.<service>.export_user` with `{ service, data }` for a `{ user_id }`, and erases the user's data when `identity.user.deleted` arrives. Erasure runs in a durable consumer named `<service>-user_erasure`, so a service that was down when a user was deleted catches up when it starts. The event's `held` field is true when a legal hold kept isolated copies; objects under `legal-hold/` must stay. Identity writes `{ user_id, deleted_at }` to the deletion ledger at the backup destination after its own erasure.

---

## For developers

### A service

```ts
import {
  createServiceRouter,
  defineErrors,
  defineNotificationCategories,
  definePermissions,
  defineService,
  ProblemError,
  type ServiceContext,
} from '@qtiauth/service-kit';
import * as z from 'zod';

export const definition = defineService({
  name: 'support',
  version: packageJson.version,
  module: 'support',
  sections: ['features'],
  database: { schema: 'support', migrations: () => loadMigrations(migrationsDir) },
  permissions: definePermissions({
    'support.tickets.staff': { description: 'Read and answer every ticket' },
  }),
  notifications: defineNotificationCategories({
    'support.ticket_updates': { description: 'Replies and status changes on your tickets' },
    'support.new_tickets': { description: 'A new ticket was opened', audience: 'staff' },
  }),
  errors: defineErrors({
    TICKET_NOT_FOUND: { status: 404, title: 'Ticket not found' },
  }),
});

export type Context = ServiceContext<typeof definition, Database>;
export const router = createServiceRouter<Context>(definition);
```

- `name` is the bus name (`qtiauth.rpc.<name>.*`) and the identity token audience.
- `sections` lists the config sections the service needs beyond the shared ones (`service`, `observability`, `bus`, `database`, `migrations`). `ctx.config` is typed to match.
- With `database`, `ctx.db` is a `Kysely<Database>` for the service's schema and `ctx.outbox` is its outbox relay. Include `createBusTablesV1` in the migrations. Without `database`, both are `undefined`.
- Put `readinessChecks` on `startService` for dependencies beyond NATS and the database, such as Valkey.

`src/main.ts` starts it, and `src/cli.ts` is the image's `qtiauth` command:

```ts
await runService(definition, {
  router,
  dataRights: ({ db }) => ({ exportUser, eraseUser }),
  start: async (ctx) => [await consumeEvents(ctx.bus, ctx.db, { … })],
});
```

```ts
await runServiceCli(definition, router, { 'audit verify': auditVerify });
```

`runServiceCli` includes `config check`, `db provision`, `migrate status|up` for the service's schema and `routes manifest|openapi`, plus any commands you pass. Build commands that need config with `configCommand` from `@qtiauth/cli`. Copy `templates/service` to start a new service.

### Routes

```ts
router.route({
  method: 'PATCH',
  path: '/api/v1/support/tickets/:ticket_id',
  operation_id: 'updateTicket',
  summary: 'Change a ticket’s status',
  auth: 'session',
  permissions: ['support.tickets.staff'],
  allow_account_states: ['active', 'locked'],
  rate_limit: 'global',
  request: {
    params: z.object({ ticket_id: z.uuid() }),
    body: z.object({ status: z.enum(['open', 'closed']) }),
  },
  responses: { 200: { description: 'The ticket', schema: ticketSchema } },
  errors: ['TICKET_NOT_FOUND'],
  handler: async ({ ctx, params, body, identity, log }) => {
    const ticket = await updateStatus(ctx.db, params.ticket_id, body.status);
    if (!ticket) throw new ProblemError('TICKET_NOT_FOUND');
    return { status: 200, body: ticket };
  },
});
```

The one definition produces the manifest, the OpenAPI operation, request validation and the policy checks. Policy fields are as follows: `auth` and `rate_limit` are required, `permissions` and `scopes` default to none, `allow_account_states` to `['active']`, and `allow_pending_legal`, `allow_pending_parental_consent`, `allow_pending_2fa_enrolment`, `allow_aal0` and `step_up` to `false`.

`router.route` throws `RouteDefinitionError` straight away for a mistake the gateway would otherwise find later: a malformed path, `request.params` that don't match the path, a body on `GET`, an undeclared permission or error code, scopes on a session route, `step_up` or `allow_aal0` without `auth: session`, and duplicate paths or operation IDs. A test that imports the router is enough to catch them.

Handlers get the parsed `params`, `query` and `body`, the caller's `identity`, a `log` carrying the request ID and hashed user ID, and the raw `request`. Return `{ status, body }` for one of the declared responses, `{ status }` for one without a schema, or a `Response`.

Throw `ProblemError(code, { detail, extensions, headers })` for an error. A route should list the codes it throws in `errors`. The kit's own codes are added automatically. A code the route didn't list still works, but logs a warning, since the OpenAPI document won't mention it.

### Permissions

```ts
definePermissions({
  'safety.reports.read': { description: 'Read reports' },
  'safety.csea.access': { description: 'CSEA cases', wildcard: false },
});
```

A grant of `*` or `safety.*` covers `safety.reports.read`. Permissions with `wildcard: false` are only covered by granting them by name.

### Pagination

```ts
const position = z.object({ created_at: z.iso.datetime(), id: z.uuid() });

router.route({
  …,
  request: { query: paginationQuery({ defaultLimit: 25, maxLimit: 100 }) },
  responses: { 200: { description: 'Tickets', schema: pageSchema(ticketSchema) } },
  handler: async ({ ctx, query }) => {
    const after = decodeCursor(position, query.cursor);
    const rows = await listTickets(ctx.db, { after, limit: query.limit + 1 });
    return { status: 200, body: pageOf(rows, query.limit, (t) => ({ created_at: t.created_at, id: t.id })) };
  },
});
```

Fetch one row more than `limit`, so `pageOf` knows whether there's another page. `decodeCursor` throws `INVALID_CURSOR` for anything that doesn't match `position`. Filter by what the caller may see as well as by the cursor, since a client can write any cursor it likes.

### Tests

`@qtiauth/service-kit/testing` has what a test needs to call a service as the gateway would:

```ts
import {
  generateIdentityKey,
  identityHeaders,
  serveTestIdentityKeys,
} from '@qtiauth/service-kit/testing';

const key = generateIdentityKey();
serveTestIdentityKeys(gatewayBus, key);

const service = await startService(definition, { router, config, port: 0, tracing: false });
await fetch(`${service.url}/api/v1/support/tickets`, {
  headers: identityHeaders(key, 'support', { permissions: ['support.tickets.staff'] }),
});
await service.stop();
```

For tests without NATS or Postgres, build the HTTP app directly with `createHttpApp` and `identityKeys: key.keys`, and call `app.request(path, init)`.
