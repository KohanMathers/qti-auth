import { isIP } from 'node:net';

import * as z from 'zod';

import { duration, requiredDuration } from './duration.ts';

function toggle(enabled: boolean, description: string) {
  return z
    .strictObject({ enabled: z.boolean().default(enabled).describe(`Enable ${description}.`) })
    .prefault({})
    .describe(description);
}

function isOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === value;
  } catch {
    return false;
  }
}

function isIpOrCidr(value: string): boolean {
  const [address = '', prefix, ...rest] = value.split('/');
  const version = isIP(address);
  if (version === 0 || rest.length > 0) return false;
  if (prefix === undefined) return true;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  return Number(prefix) <= (version === 4 ? 32 : 128);
}

const email = z.email('Must be an email address');

const sender = (name: string, address: string, purpose: string) =>
  z
    .strictObject({
      name: z.string().min(1).default(name).describe('Display name.'),
      address: email.default(address).describe('Email address.'),
    })
    .prefault({})
    .describe(`Sender for ${purpose} email.`);

export const branding = z
  .strictObject({
    product_name: z
      .string()
      .min(1)
      .default('Example Account')
      .describe('Product name shown to users.'),
    company_name: z
      .string()
      .min(1)
      .default('Example Ltd')
      .describe('Company name used in legal text and emails.'),
    support_email: email
      .default('support@example.com')
      .describe('Support contact address shown to users.'),
    logo: z
      .string()
      .min(1)
      .nullable()
      .default(null)
      .describe('Logo path, relative to the config directory. null shows the product name.'),
    colors: z
      .strictObject({
        primary: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/, 'Must be a hex colour like #3b82f6')
          .default('#3b82f6')
          .describe('Primary brand colour.'),
      })
      .prefault({})
      .describe('Brand colours.'),
  })
  .prefault({})
  .describe('Product and company branding.');

export const MODULES = ['identity', 'oidc', 'games', 'safety', 'support', 'admin'] as const;
export const SURFACES = ['account', 'support', 'api'] as const;

const surface = (defaultBasePath: string, purpose: string) =>
  z
    .strictObject({
      hosts: z
        .array(z.hostname('Must be a hostname, without scheme or port'))
        .default([])
        .describe('Hostnames this surface answers on.'),
      ports: z
        .array(z.int().min(1).max(65_535))
        .default([])
        .describe('Ports this surface answers on, for host-less setups.'),
      base_path: z
        .string()
        .regex(
          /^\/(?:[\w.~-]+(?:\/[\w.~-]+)*)?$/,
          'Must start with "/" and not end with "/", e.g. / or /support',
        )
        .default('/')
        .describe('Path prefix the surface is mounted under.'),
      modules: z
        .array(z.enum(MODULES))
        .nullable()
        .default(null)
        .describe('Modules this surface owns. null uses the default ownership.'),
      origins: z
        .array(z.string().refine(isOrigin, 'Must be an origin like https://app.example.com'))
        .nullable()
        .default(null)
        .describe(
          'Public origins browsers use for this surface, for CORS, the Origin check and feature discovery. null uses https://<host> for each host.',
        ),
    })
    .refine((s) => s.hosts.length > 0 || s.ports.length > 0, {
      message: 'Set at least one of hosts or ports',
      path: ['hosts'],
    })
    .prefault({ hosts: ['localhost'], base_path: defaultBasePath })
    .describe(purpose);

export const surfaces = z
  .strictObject({
    account: surface('/', 'Main account site and primary sign-in surface.'),
    support: surface('/support', 'Help centre.'),
    api: surface('/api', 'Non-browser clients: games, game servers and third-party apps.'),
  })
  .superRefine((value, ctx) => {
    for (const [i, a] of SURFACES.entries()) {
      for (const b of SURFACES.slice(i + 1)) {
        const first = value[a];
        const second = value[b];
        const sharesBinding =
          first.hosts.some((host) => second.hosts.includes(host)) ||
          first.ports.some((port) => second.ports.includes(port));
        if (sharesBinding && first.base_path === second.base_path) {
          ctx.addIssue({
            code: 'custom',
            message: `Same host or port and base_path as surfaces.${a}`,
            path: [b, 'base_path'],
          });
        }
      }
    }
  })
  .prefault({})
  .describe('Where each web surface is served.');

export const cookies = z
  .strictObject({
    name: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/, 'Must be letters, digits, - or _')
      .default('qtiauth_session')
      .describe('Session cookie name. Gets the __Host- prefix when domain is null.'),
    domain: z
      .hostname('Must be a domain, without a leading dot')
      .nullable()
      .default(null)
      .describe('Shared cookie domain. null uses host-only __Host- cookies.'),
    session_ttl: duration('7d', 'Maximum session lifetime.'),
    idle_timeout: duration('30d', 'Session ends after this long without activity.'),
  })
  .prefault({})
  .describe('Session cookie settings.');

export const cors = z
  .strictObject({
    allowed_origins: z
      .array(z.string().refine(isOrigin, 'Must be an origin like https://app.example.com'))
      .default([])
      .describe('Extra credentialed CORS origins. Surface origins are added automatically.'),
  })
  .prefault({})
  .describe('Cross-origin requests.');

export const network = z
  .strictObject({
    trusted_proxies: z
      .array(z.string().refine(isIpOrCidr, 'Must be an IP address or CIDR range'))
      .default([])
      .describe('Proxies whose forwarded client IP headers are trusted.'),
  })
  .prefault({})
  .describe('Network settings.');

export const geoip = z
  .strictObject({
    source: z
      .enum(['dbip_lite', 'maxmind', 'header', 'none'])
      .default('dbip_lite')
      .describe('Where IP geolocation comes from.'),
    header: z
      .string()
      .min(1)
      .nullable()
      .default(null)
      .describe('Request header holding the country code when source is header.'),
  })
  .refine((g) => g.source !== 'header' || g.header !== null, {
    message: 'Required when source is header',
    path: ['header'],
  })
  .prefault({})
  .describe('IP geolocation.');

export const DB_SCHEMAS = ['identity', 'notify', 'oidc', 'safety', 'support', 'games'] as const;
export type DbSchema = (typeof DB_SCHEMAS)[number];

const dbRole = (schema: string) =>
  z
    .strictObject({
      user: z
        .string()
        .min(1)
        .default(`qtiauth_${schema}`)
        .describe(`Postgres role for the ${schema} schema.`),
      password: z.string().default('').describe("The role's password. Reference a secret."),
    })
    .prefault({})
    .describe(`Credentials for the service that owns the ${schema} schema.`);

export const database = z
  .strictObject({
    host: z.string().min(1).default('postgres').describe('Postgres host.'),
    port: z.int().min(1).max(65_535).default(5432).describe('Postgres port.'),
    name: z.string().min(1).default('qtiauth').describe('Database name.'),
    ssl: z
      .enum(['disable', 'require', 'verify-full'])
      .default('disable')
      .describe(
        'TLS to Postgres. require encrypts without checking the certificate, verify-full also checks it.',
      ),
    pool: z
      .strictObject({
        max: z.int().min(1).default(10).describe('Maximum connections per service replica.'),
        idle_timeout: duration('30s', 'Close idle connections after this long.'),
        connect_timeout: duration('10s', 'Give up connecting after this long.'),
      })
      .prefault({})
      .describe('Connection pool.'),
    roles: z
      .strictObject(
        Object.fromEntries(DB_SCHEMAS.map((schema) => [schema, dbRole(schema)])) as Record<
          DbSchema,
          ReturnType<typeof dbRole>
        >,
      )
      .prefault({})
      .describe('One role per service schema. Each role can only use its own schema.'),
  })
  .prefault({})
  .describe('PostgreSQL connection.');

export const migrations = z
  .strictObject({
    auto_apply: z
      .boolean()
      .default(true)
      .describe('Apply pending database migrations when a service starts.'),
  })
  .prefault({})
  .describe('Database migrations.');

function isNatsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ['nats:', 'tls:'].includes(url.protocol) && url.hostname !== '' && url.pathname === '';
  } catch {
    return false;
  }
}

export const bus = z
  .strictObject({
    servers: z
      .array(z.string().refine(isNatsUrl, 'Must be a NATS URL like nats://nats:4222'))
      .min(1)
      .default(['nats://nats:4222'])
      .describe('NATS servers to connect to.'),
    user: z
      .string()
      .min(1)
      .nullable()
      .default(null)
      .describe('NATS user. null connects without credentials.'),
    password: z.string().default('').describe("The NATS user's password. Reference a secret."),
    tls: z
      .strictObject({
        required: z
          .boolean()
          .default(false)
          .describe('Refuse to connect without TLS. TLS is used anyway when the server offers it.'),
        ca_file: z
          .string()
          .min(1)
          .nullable()
          .default(null)
          .describe('CA certificate file for verifying the server. null uses the system CAs.'),
      })
      .prefault({})
      .describe('TLS to NATS.'),
    connect_timeout: duration('10s', 'Give up connecting after this long.'),
    request_timeout: duration('5s', 'Default deadline for request/reply calls between services.'),
    streams: z
      .strictObject({
        replicas: z
          .int()
          .min(1)
          .max(5)
          .default(1)
          .describe('JetStream replicas per stream. Use 3 on a NATS cluster.'),
        events_max_age: duration('7d', 'Keep domain events in the stream for this long.'),
        work_max_age: duration(
          '7d',
          'Drop cron ticks and work-queue jobs nobody took after this long.',
        ),
        duplicate_window: duration(
          '2m',
          'JetStream drops a message whose ID it has already seen within this window.',
        ),
      })
      .prefault({})
      .describe('JetStream streams, created or updated when a service starts.'),
    outbox: z
      .strictObject({
        poll_interval: duration('1s', 'Check the outbox for unsent events this often.'),
        batch_size: z
          .int()
          .min(1)
          .max(1000)
          .default(100)
          .describe('Events published per outbox transaction.'),
        sent_retention: duration('1d', 'Delete published events from the outbox after this long.'),
      })
      .prefault({})
      .describe('Transactional outbox relay.'),
    consumers: z
      .strictObject({
        ack_wait: duration('30s', 'Redeliver a message if a consumer neither acks nor extends it.'),
        max_deliver: z
          .int()
          .min(1)
          .default(10)
          .describe('Give up on a message after this many delivery attempts.'),
        retry_delay: duration('1s', 'Delay before the first retry. Doubles with each attempt.'),
        max_retry_delay: duration('5m', 'Longest delay between retries.'),
        dedupe_retention: duration(
          '14d',
          'Remember processed event IDs for this long. Must be at least streams.events_max_age.',
        ),
      })
      .prefault({})
      .describe('Event, cron and work-queue consumers.'),
  })
  .superRefine((b, ctx) => {
    if (b.password && b.user === null) {
      ctx.addIssue({ code: 'custom', message: 'Required when password is set', path: ['user'] });
    }
    if (b.consumers.dedupe_retention < b.streams.events_max_age) {
      ctx.addIssue({
        code: 'custom',
        message: 'Must be at least streams.events_max_age, or redelivered events could run twice',
        path: ['consumers', 'dedupe_retention'],
      });
    }
    if (b.consumers.max_retry_delay < b.consumers.retry_delay) {
      ctx.addIssue({
        code: 'custom',
        message: 'Must be at least retry_delay',
        path: ['consumers', 'max_retry_delay'],
      });
    }
  })
  .prefault({})
  .describe('NATS JetStream message bus.');

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;

export const observability = z
  .strictObject({
    logs: z
      .strictObject({
        level: z.enum(LOG_LEVELS).default('info').describe('Lowest level written to the log.'),
        user_id_hash_key: z
          .string()
          .default('')
          .describe(
            'Key for hashing user IDs in logs. Use the same key on every service so logs can be joined. Reference a secret.',
          ),
        redact_keys: z
          .array(z.string().regex(/^[A-Za-z0-9_-]+$/, 'Must be a field name like session_code'))
          .default([])
          .describe(
            'Extra field names whose values are never logged, on top of the built-in list (passwords, tokens, secrets, codes and the like).',
          ),
      })
      .prefault({})
      .describe('Structured JSON logs, written to standard output.'),
    tracing: z
      .strictObject({
        enabled: z
          .boolean()
          .default(false)
          .describe(
            'Send traces to an OTLP collector. Trace IDs are still created, logged and passed between services when off.',
          ),
        endpoint: z
          .url({ protocol: /^https?$/ })
          .default('http://tempo:4318/v1/traces')
          .describe('OTLP/HTTP traces endpoint.'),
        sample_ratio: z
          .number()
          .min(0)
          .max(1)
          .default(1)
          .describe('Share of traces to keep, from 0 to 1. Every service must use the same value.'),
      })
      .prefault({})
      .describe('OpenTelemetry tracing.'),
    metrics: z
      .strictObject({
        process_metrics: z
          .boolean()
          .default(true)
          .describe('Also report Node.js process metrics (CPU, memory, event loop, GC).'),
      })
      .prefault({})
      .describe('Prometheus metrics, served on /metrics on the internal network.'),
    health: z
      .strictObject({
        check_timeout: duration(
          '2s',
          'Count a /readyz dependency check as failed if it takes longer than this.',
        ),
      })
      .prefault({})
      .describe('Health endpoints.'),
  })
  .prefault({})
  .describe('Logs, traces, metrics and health checks.');

export const service = z
  .strictObject({
    http: z
      .strictObject({
        port: z
          .int()
          .min(1)
          .max(65_535)
          .default(8080)
          .describe('Port each service listens on, on the internal network.'),
        shutdown_timeout: duration(
          '15s',
          'On SIGTERM or SIGINT, wait this long for in-flight requests and background work before exiting anyway.',
        ),
      })
      .prefault({})
      .describe('Internal HTTP server.'),
    identity_tokens: z
      .strictObject({
        clock_tolerance: duration(
          '5s',
          'Allowed clock difference between the gateway and a service when checking internal identity token times.',
        ),
        keys_refresh: duration(
          '5m',
          "Fetch the gateway's identity token public keys this often. Keys the service hasn't seen are fetched straight away.",
        ),
      })
      .prefault({})
      .describe('Internal identity tokens minted by the gateway (X-QTIAuth-Identity).'),
  })
  .prefault({})
  .describe('Settings shared by every service.');

export const valkey = z
  .strictObject({
    host: z.string().min(1).default('valkey').describe('Valkey host.'),
    port: z.int().min(1).max(65_535).default(6379).describe('Valkey port.'),
    user: z
      .string()
      .min(1)
      .nullable()
      .default(null)
      .describe('Valkey ACL user. null uses the default user.'),
    password: z
      .string()
      .default('')
      .describe('Valkey password. Empty connects without one. Reference a secret.'),
    database: z.int().min(0).default(0).describe('Logical database number.'),
    tls: z
      .strictObject({
        enabled: z.boolean().default(false).describe('Connect over TLS.'),
        ca_file: z
          .string()
          .min(1)
          .nullable()
          .default(null)
          .describe('CA certificate file for verifying the server. null uses the system CAs.'),
      })
      .prefault({})
      .describe('TLS to Valkey.'),
    connect_timeout: duration('5s', 'Give up connecting after this long.'),
    command_timeout: duration(
      '1s',
      'Treat Valkey as unavailable when a command takes longer than this.',
    ),
  })
  .prefault({})
  .describe('Valkey, for rate limits, the session cache and short-lived state.');

const SERVICE_NAME = /^[a-z][a-z0-9_]*$/;

export const gateway = z
  .strictObject({
    http: z
      .strictObject({
        port: z
          .int()
          .min(1)
          .max(65_535)
          .default(8000)
          .describe(
            'Public port for surfaces bound to hosts. Surfaces bound to ports listen on their own ports.',
          ),
        max_body_size: z
          .int()
          .min(1)
          .default(1_048_576)
          .describe('Largest request body the gateway accepts, in bytes.'),
        upstream_timeout: duration('30s', 'Give up on a service response after this long.'),
      })
      .prefault({})
      .describe('Public HTTP listener.'),
    upstreams: z
      .record(
        z.string().regex(SERVICE_NAME, 'Must be a service name like identity'),
        z.url({ protocol: /^https?$/ }),
      )
      .default({})
      .describe(
        'Base URL per service. Services not listed are reached at http://<service>:<service.http.port>.',
      ),
    discovery: z
      .strictObject({
        interval: duration('30s', 'Ask every service to announce itself this often.'),
        expiry: duration(
          '90s',
          "Forget a service instance that hasn't announced itself for this long.",
        ),
        startup_grace: duration(
          '5s',
          "After starting, wait this long for announcements before reporting services that aren't running.",
        ),
      })
      .refine((d) => d.expiry > d.interval, {
        message: 'Must be longer than interval',
        path: ['expiry'],
      })
      .prefault({})
      .describe('Service discovery over qtiauth.sys.announce.'),
    session_cache: z
      .strictObject({
        ttl: duration(
          '1m',
          'Keep a resolved session in Valkey for this long. Revocations and account changes clear it sooner.',
        ),
      })
      .prefault({})
      .describe('Session lookup cache.'),
    identity_keys: z
      .strictObject({
        encryption_key: z
          .string()
          .default('')
          .describe(
            'Base64 32-byte key that encrypts the signing keys at rest. Required to start the gateway. Reference a secret.',
          ),
        rotate_after: duration('30d', 'Replace the signing key once it is this old.'),
        retain_after_rotation: duration(
          '1h',
          'Keep publishing a replaced key for this long, so tokens it signed can still be checked.',
        ),
      })
      .prefault({})
      .describe('Signing keys for internal identity tokens (X-QTIAuth-Identity).'),
    hsts: z
      .strictObject({
        max_age: duration('365d', 'How long browsers remember to use HTTPS only.'),
        include_subdomains: z
          .boolean()
          .default(false)
          .describe('Apply HSTS to every subdomain of each surface host too.'),
        preload: z
          .boolean()
          .default(false)
          .describe('Ask to be included in browser preload lists.'),
      })
      .prefault({})
      .describe('Strict-Transport-Security header.'),
  })
  .prefault({})
  .describe('Gateway: the single public entry point.');

export const RATE_LIMIT_DIMENSIONS = ['ip', 'user', 'client', 'email', 'account'] as const;
export type RateLimitDimension = (typeof RATE_LIMIT_DIMENSIONS)[number];

const RATE_LIMIT_NAME = /^[a-z][a-z0-9_]*$/;

const rateLimitPolicy = z
  .strictObject({
    per: z
      .union([z.enum(RATE_LIMIT_DIMENSIONS), z.array(z.enum(RATE_LIMIT_DIMENSIONS)).min(1)])
      .transform((per) => [...new Set(Array.isArray(per) ? per : [per])])
      .describe(
        'What requests are counted by. A list counts each combination separately, e.g. [ip, account] counts each IP and account pair.',
      ),
    limit: z.int().min(1).describe('Requests allowed per window.'),
    window: requiredDuration('Sliding window length.'),
    on_store_failure: z
      .enum(['open', 'closed'])
      .default('open')
      .describe('When Valkey is unreachable, let requests through (open) or refuse them (closed).'),
  })
  .describe('A rate limit.');

const rateLimitGroup = z
  .strictObject({
    policies: z
      .array(z.string().regex(RATE_LIMIT_NAME))
      .min(1)
      .describe('Policies that all apply. A request is refused if any of them is exceeded.'),
  })
  .describe('Several rate limits applied together.');

export type RateLimitPolicy = z.output<typeof rateLimitPolicy>;
export type RateLimitGroup = z.output<typeof rateLimitGroup>;

const DEFAULT_RATE_LIMITS = {
  global: { per: 'ip', limit: 300, window: '1m' },
  auth_password: { per: ['ip', 'account'], limit: 10, window: '15m', on_store_failure: 'closed' },
  magic_link_email: { per: 'email', limit: 3, window: '1h', on_store_failure: 'closed' },
  magic_link_ip: { per: 'ip', limit: 10, window: '1h', on_store_failure: 'closed' },
  magic_link_ip_day: { per: 'ip', limit: 20, window: '1d', on_store_failure: 'closed' },
  magic_link: { policies: ['magic_link_email', 'magic_link_ip', 'magic_link_ip_day'] },
  ticket_create: { per: 'user', limit: 5, window: '1h' },
  guest_ticket: { per: 'ip', limit: 3, window: '1h' },
  key_redeem: { per: ['ip', 'user'], limit: 10, window: '1h' },
  kb_feedback: { per: 'ip', limit: 30, window: '1h' },
} as const;

export const rateLimits = z
  .record(
    z.string().regex(RATE_LIMIT_NAME, 'Must be a policy name like ticket_create'),
    z.union([rateLimitPolicy, rateLimitGroup]),
  )
  .default({})
  .transform((policies) => ({
    ...z.record(z.string(), z.union([rateLimitPolicy, rateLimitGroup])).parse(DEFAULT_RATE_LIMITS),
    ...policies,
  }))
  .superRefine((policies, ctx) => {
    if (!('limit' in (policies['global'] ?? {}))) {
      ctx.addIssue({
        code: 'custom',
        message: 'global must be a single policy. It applies to every request',
        path: ['global'],
      });
    }
    for (const [name, policy] of Object.entries(policies)) {
      if (!('policies' in policy)) continue;
      policy.policies.forEach((member, index) => {
        const target = policies[member];
        if (target === undefined || 'policies' in target) {
          ctx.addIssue({
            code: 'custom',
            message: `Must name a single policy, not ${target === undefined ? 'an unknown one' : 'a group'}`,
            path: [name, 'policies', index],
          });
        }
      });
    }
  })
  .describe(
    'Named rate-limit policies, referenced by routes. Policies you set replace the built-in policy of the same name.',
  );

export const security = z
  .strictObject({
    step_up_window: duration(
      '10m',
      'Routes that need step-up accept a session that reached aal2 within this long.',
    ),
  })
  .prefault({})
  .describe('Account security.');

const oauthProvider = (name: string) =>
  z
    .strictObject({
      enabled: z.boolean().default(false).describe(`Enable sign-in with ${name}.`),
      client_id: z.string().default('').describe('OAuth client ID.'),
      client_secret: z.string().default('').describe('OAuth client secret. Reference a secret.'),
    })
    .superRefine((p, ctx) => {
      if (!p.enabled) return;
      for (const key of ['client_id', 'client_secret'] as const) {
        if (!p[key]) {
          ctx.addIssue({ code: 'custom', message: 'Required when enabled', path: [key] });
        }
      }
    })
    .prefault({})
    .describe(`${name} sign-in.`);

const genericOidcProvider = z
  .strictObject({
    id: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]*$/, 'Must be lowercase letters, digits, - or _')
      .describe('Stable identifier used in URLs and linked accounts.'),
    name: z.string().min(1).describe('Name shown on the sign-in button.'),
    issuer: z.url({ protocol: /^https?$/ }).describe('OIDC issuer URL.'),
    client_id: z.string().min(1).describe('OAuth client ID.'),
    client_secret: z.string().min(1).describe('OAuth client secret. Reference a secret.'),
    scopes: z
      .array(z.string().min(1))
      .default(['openid', 'email', 'profile'])
      .describe('Scopes to request.'),
    icon: z.string().min(1).nullable().default(null).describe('Icon path or URL.'),
  })
  .describe('An upstream OpenID Connect provider.');

export const features = z
  .strictObject({
    auth: z
      .strictObject({
        password: toggle(true, 'password sign-in'),
        magic_link: toggle(true, 'magic link sign-in'),
        passkeys: toggle(true, 'passkeys'),
        totp: toggle(true, 'TOTP two-factor'),
        social: z
          .strictObject({
            google: oauthProvider('Google'),
            github: oauthProvider('GitHub'),
            discord: oauthProvider('Discord'),
            steam: toggle(false, 'Steam sign-in'),
            generic_oidc: z
              .array(genericOidcProvider)
              .default([])
              .refine((list) => new Set(list.map((p) => p.id)).size === list.length, {
                message: 'Provider ids must be unique',
              })
              .describe('Upstream OIDC providers.'),
          })
          .prefault({})
          .describe('Social and upstream sign-in.'),
      })
      .prefault({})
      .describe('Authentication methods.'),
    session_security: toggle(true, 'session security checks'),
    oidc: z
      .strictObject({
        developer_portal: toggle(true, 'the developer portal'),
        backchannel_logout: toggle(true, 'back-channel logout'),
      })
      .prefault({})
      .describe('OIDC provider features (oidc profile).'),
    games: z
      .strictObject({
        licensing: toggle(true, 'offline licensing'),
        steam: toggle(false, 'Steam integration'),
        leaderboards: z
          .strictObject({
            enabled: z.boolean().default(true).describe('Enable leaderboards.'),
            require_game_authority: z
              .boolean()
              .default(true)
              .describe(
                "Leaderboard scores need the game server's credential as well as the player's.",
              ),
          })
          .prefault({})
          .describe('Leaderboards.'),
        playtime: toggle(true, 'playtime tracking'),
        cloud_saves: toggle(false, 'cloud saves (needs object storage)'),
        keys: toggle(true, 'key redemption'),
      })
      .prefault({})
      .describe('Games features (games profile).'),
    support: z
      .strictObject({
        tickets: toggle(true, 'support tickets'),
        kb: toggle(true, 'the knowledge base'),
        guest_tickets: toggle(true, 'tickets from signed-out users'),
        attachments: toggle(false, 'ticket attachments (needs object storage)'),
      })
      .prefault({})
      .describe('Support features (support profile).'),
  })
  .prefault({})
  .describe('Feature flags inside services.');

export const captcha = z
  .strictObject({
    provider: z
      .enum(['altcha', 'turnstile', 'hcaptcha', 'friendly_captcha', 'none'])
      .default('altcha')
      .describe('CAPTCHA provider.'),
  })
  .prefault({})
  .describe('Bot protection.');

export const emailSection = z
  .strictObject({
    provider: z
      .enum(['smtp', 'brevo', 'postmark', 'ses', 'resend', 'mailgun', 'console'])
      .default('smtp')
      .describe('Email delivery provider. console prints emails instead of sending them.'),
    from: z
      .strictObject({
        auth: sender('Example Auth', 'auth@example.com', 'sign-in and verification'),
        security: sender('Example Security', 'security@example.com', 'security alert'),
        support: sender('Example Support', 'support@example.com', 'support'),
      })
      .prefault({})
      .describe('Sender identities.'),
  })
  .prefault({})
  .describe('Outgoing email.');

export const sections = {
  branding,
  surfaces,
  cookies,
  cors,
  network,
  geoip,
  database,
  migrations,
  bus,
  observability,
  service,
  valkey,
  gateway,
  features,
  captcha,
  email: emailSection,
  security,
  rate_limits: rateLimits,
};

export type SectionName = keyof typeof sections;
