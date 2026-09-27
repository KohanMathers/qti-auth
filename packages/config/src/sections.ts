import { isIP } from 'node:net';

import { Cron } from 'croner';
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

export const GEOIP_SOURCES = ['dbip_lite', 'maxmind', 'header', 'none'] as const;
export type GeoipSource = (typeof GEOIP_SOURCES)[number];

export const geoip = z
  .strictObject({
    source: z.enum(GEOIP_SOURCES).default('dbip_lite').describe('Where IP geolocation comes from.'),
    header: z
      .string()
      .min(1)
      .nullable()
      .default(null)
      .describe('Request header holding the country code when source is header.'),
    database_path: z
      .string()
      .min(1)
      .default('/var/lib/qtiauth/geoip/dbip-country-lite.csv.gz')
      .describe(
        'Country database file. DB-IP Lite CSV or gzipped CSV, or a MaxMind MMDB when source is maxmind.',
      ),
  })
  .refine((g) => g.source !== 'header' || g.header !== null, {
    message: 'Required when source is header',
    path: ['header'],
  })
  .prefault({})
  .describe('IP geolocation.');

export const textFilter = z
  .strictObject({
    lists_dir: z
      .string()
      .min(1)
      .default('lists/username')
      .describe(
        'Word-list directory, relative to the config file. Holds LDNOOBW, the dictionary, names, surnames, places, allow.txt and extra-block.txt.',
      ),
  })
  .prefault({})
  .describe('Public-text filter.');

export const DB_SCHEMAS = ['identity', 'notify', 'oidc', 'safety', 'support', 'games'] as const;
export type DbSchema = (typeof DB_SCHEMAS)[number];

const dbRole = (name: string, purpose = `${name} schema`) =>
  z
    .strictObject({
      user: z
        .string()
        .min(1)
        .default(`qtiauth_${name}`)
        .describe(`Postgres role for the ${purpose}.`),
      password: z.string().default('').describe("The role's password. Reference a secret."),
    })
    .prefault({})
    .describe(`Credentials for the service that owns the ${purpose}.`);

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
    audit: dbRole('audit', 'audit log').describe(
      'Postgres role for the audit log. Identity grants it INSERT and SELECT only on identity.audit_log.',
    ),
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
        refresh: duration(
          '30s',
          'Reload signing keys from the store this often, so other gateway replicas pick up a rotation.',
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

const DEFAULT_SAFETY_RATE_LIMITS = {
  safety_report: { per: ['ip', 'user'], limit: 20, window: '1h', on_store_failure: 'closed' },
  safety_intake: { per: 'client', limit: 600, window: '1m', on_store_failure: 'closed' },
  safety_appeal: { per: ['ip', 'user'], limit: 10, window: '1h', on_store_failure: 'closed' },
} as const;

const DEFAULT_RATE_LIMITS = {
  global: { per: 'ip', limit: 300, window: '1m' },
  auth_password: { per: ['ip', 'account'], limit: 10, window: '15m', on_store_failure: 'closed' },
  magic_link_email: { per: 'email', limit: 3, window: '1h', on_store_failure: 'closed' },
  magic_link_ip: { per: 'ip', limit: 10, window: '1h', on_store_failure: 'closed' },
  magic_link_ip_day: { per: 'ip', limit: 20, window: '1d', on_store_failure: 'closed' },
  magic_link: { policies: ['magic_link_email', 'magic_link_ip', 'magic_link_ip_day'] },
  auth_verify: { per: 'ip', limit: 30, window: '15m', on_store_failure: 'closed' },
  ticket_create: { per: 'user', limit: 5, window: '1h' },
  guest_ticket: { per: 'ip', limit: 3, window: '1h' },
  key_redeem: { per: ['ip', 'user'], limit: 10, window: '1h' },
  kb_feedback: { per: 'ip', limit: 30, window: '1h' },
  oauth_authorize: { per: 'ip', limit: 60, window: '1m' },
  oauth_token: { per: 'ip', limit: 60, window: '1m', on_store_failure: 'closed' },
  ...DEFAULT_SAFETY_RATE_LIMITS,
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

export const PERMISSION_GRANT = /^(?:\*|[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*(?:\.\*)?)$/;
export const PERMISSION_GRANT_MESSAGE = 'Must be a permission, a prefix like users.*, or *';
export const ROLE_SLUG = /^[a-z][a-z0-9_]{0,62}$/;
export const ROLE_SLUG_MESSAGE = 'Must be a lowercase slug like support_agent';
export const ROLE_NAME_MAX = 80;
export const ROLE_DESCRIPTION_MAX = 500;

export const DEFAULT_REQUIRE_2FA_PERMISSIONS = [
  'users.*',
  'safety.*',
  'support.*',
  'games.*',
  'oidc.clients.*',
  'webhooks.manage',
  'audit.read',
  'roles.manage',
  'filter.*',
] as const;

export const security = z
  .strictObject({
    step_up_window: duration(
      '10m',
      'Routes that need step-up accept a session that reached aal2 within this long.',
    ),
    encryption_key: z
      .string()
      .default('')
      .describe(
        'Base64 32-byte key that encrypts TOTP secrets at rest. Required when TOTP is enabled. Reference a secret.',
      ),
    require_2fa_for_permissions: z
      .array(
        z
          .string()
          .regex(PERMISSION_GRANT, PERMISSION_GRANT_MESSAGE)
          .describe('A permission or prefix that requires two-factor enrolment.'),
      )
      .default([...DEFAULT_REQUIRE_2FA_PERMISSIONS])
      .describe(
        'Staff whose permissions match any of these must enrol a passkey or TOTP before using the rest of the product. Prefixes end in .* .',
      ),
  })
  .prefault({})
  .describe('Account security.');

export const ADMIN_ROLE = 'admin';

const roleDefinition = z
  .strictObject({
    name: z.string().trim().min(1).max(ROLE_NAME_MAX).describe('Display name.'),
    description: z
      .string()
      .trim()
      .min(1)
      .max(ROLE_DESCRIPTION_MAX)
      .describe('What this role is for.'),
    permissions: z
      .array(
        z
          .string()
          .regex(PERMISSION_GRANT, PERMISSION_GRANT_MESSAGE)
          .describe('A permission, a prefix ending in .*, or *.'),
      )
      .refine((grants) => new Set(grants).size === grants.length, {
        message: 'Permissions must be unique',
      })
      .describe(
        'Permission grants this role confers. * does not include permissions that must be granted by name.',
      ),
  })
  .describe('A staff role.');

export const DEFAULT_ROLES = {
  admin: {
    name: 'Admin',
    description: 'Full access, except permissions that must be granted by name.',
    permissions: ['*'],
  },
  moderator: {
    name: 'Moderator',
    description: 'Moderate users, reports and the text filter.',
    permissions: [
      'users.read',
      'users.ban',
      'users.lock',
      'users.edit_dob',
      'users.force_username_reset',
      'safety.reports.read',
      'safety.actions.apply',
      'filter.read',
      'filter.manage',
    ],
  },
  support_agent: {
    name: 'Support agent',
    description: 'Handle support tickets.',
    permissions: ['users.read', 'support.tickets.staff'],
  },
  kb_editor: {
    name: 'Knowledge-base editor',
    description: 'Edit knowledge-base articles.',
    permissions: ['support.kb.edit'],
  },
  game_manager: {
    name: 'Game manager',
    description: 'Manage games, entitlements and keys.',
    permissions: ['games.catalog.edit', 'games.entitlements.grant', 'games.keys.manage'],
  },
};

export const roles = z
  .record(z.string().regex(ROLE_SLUG, ROLE_SLUG_MESSAGE), roleDefinition)
  .refine((value) => Object.hasOwn(value, ADMIN_ROLE), { message: 'Must include an admin role' })
  .default(DEFAULT_ROLES)
  .describe(
    'Staff roles, keyed by slug. Built-ins are seeded on startup and can then be edited with roles.manage. * never matches permissions that must be granted by name.',
  );

const emailDomainRule = z
  .strictObject({
    remove_dots: z
      .boolean()
      .default(false)
      .describe('Ignore dots in the local part, so j.doe@ and jdoe@ are the same address.'),
    subaddress_separator: z
      .string()
      .length(1)
      .nullable()
      .default(null)
      .describe(
        'Ignore the local part from this character on, so with + jo+news@ and jo@ are the same address. null keeps the whole local part.',
      ),
    domain: z
      .hostname('Must be a domain')
      .nullable()
      .default(null)
      .describe('Count addresses as belonging to this domain instead. null keeps the domain.'),
  })
  .describe('How addresses at one domain are normalized.');

const DEFAULT_EMAIL_NORMALIZATION = {
  'gmail.com': { remove_dots: true, subaddress_separator: '+', domain: null },
  'googlemail.com': { remove_dots: true, subaddress_separator: '+', domain: 'gmail.com' },
};

export const accounts = z
  .strictObject({
    max_per_email: z
      .int()
      .min(1)
      .default(2)
      .describe('Accounts allowed per normalized email address.'),
    email_normalization: z
      .record(z.hostname('Must be a domain like example.com'), emailDomainRule)
      .default(DEFAULT_EMAIL_NORMALIZATION)
      .describe(
        'Rules per email domain for deciding when two addresses are the same, on top of ignoring case. Setting this replaces the built-in rules.',
      ),
    email_change_ttl: duration(
      '15m',
      'The confirmation link sent to a new email address works for this long.',
    ),
    email_revert_ttl: duration(
      '7d',
      'The "this wasn\'t me" link sent to the previous email address works for this long.',
    ),
    deletion_grace: duration(
      '30d',
      'How long an account stays in pending_deletion after the user asks to delete it. Signing in during this time cancels the deletion.',
    ),
    export_ttl: duration(
      '7d',
      'How long a data-export download link works. After this the zip is deleted.',
    ),
    export_email_max_bytes: z
      .int()
      .min(1)
      .max(10_485_760)
      .default(524_288)
      .describe(
        'Largest export that can be emailed as an attachment when object storage is not configured. Larger exports need storage.',
      ),
  })
  .prefault({})
  .describe('Accounts.');

export const magicLink = z
  .strictObject({
    ttl: duration('15m', 'A magic link works for this long.'),
    signup_ttl: duration(
      '30m',
      'After a new user opens their magic link, they have this long to enter their date of birth.',
    ),
  })
  .prefault({})
  .describe('Magic-link sign-in.');

export const password = z
  .strictObject({
    min_length: z.int().min(1).max(256).default(10).describe('Shortest a password can be.'),
    max_length: z
      .int()
      .min(1)
      .max(256)
      .default(256)
      .describe('Longest a password can be. 256 is the hard cap.'),
    composition: z
      .strictObject({
        require_lower: z.boolean().default(false).describe('Require a lowercase letter.'),
        require_upper: z.boolean().default(false).describe('Require an uppercase letter.'),
        require_digit: z.boolean().default(false).describe('Require a digit.'),
        require_symbol: z
          .boolean()
          .default(false)
          .describe('Require a character that is not a letter or digit.'),
      })
      .prefault({})
      .describe('Optional composition rules. All off by default.'),
    breach_check: z
      .boolean()
      .default(true)
      .describe(
        'Reject passwords that appear in the Have I Been Pwned range API. Only the first 5 hex characters of a SHA-1 hash leave the server. Unreachable checks are skipped.',
      ),
    argon2: z
      .strictObject({
        memory_kib: z
          .int()
          .min(8)
          .max(1_048_576)
          .default(19_456)
          .describe('Argon2id memory in KiB. OWASP default is 19456 (19 MiB).'),
        iterations: z.int().min(1).max(16).default(2).describe('Argon2id iterations (t).'),
        parallelism: z.int().min(1).max(16).default(1).describe('Argon2id parallelism (p).'),
      })
      .prefault({})
      .describe('Argon2id parameters. Stored hashes are rehashed on login when these change.'),
    reset_ttl: duration('15m', 'A password reset link works for this long.'),
    verification_ttl: duration(
      '15m',
      'An email verification link after password signup works for this long.',
    ),
    failure_delay: z
      .strictObject({
        step: duration(
          '250ms',
          'Extra delay added for each previous failed password attempt on the account or IP.',
        ),
        max: duration('2s', 'Longest progressive delay after failed password attempts.'),
      })
      .prefault({})
      .describe(
        'Progressive delay after failed password attempts, counted per account and per IP. There is no lockout.',
      ),
  })
  .superRefine((value, ctx) => {
    if (value.min_length > value.max_length) {
      ctx.addIssue({
        code: 'custom',
        message: 'Must be less than or equal to max_length',
        path: ['min_length'],
      });
    }
    if (value.argon2.memory_kib < 8 * value.argon2.parallelism) {
      ctx.addIssue({
        code: 'custom',
        message: 'Must be at least 8 KiB per parallel lane',
        path: ['argon2', 'memory_kib'],
      });
    }
    if (value.failure_delay.step > value.failure_delay.max) {
      ctx.addIssue({
        code: 'custom',
        message: 'Must be less than or equal to max',
        path: ['failure_delay', 'step'],
      });
    }
  })
  .prefault({})
  .describe('Password sign-in.');

export const sessions = z
  .strictObject({
    max_per_user: z
      .int()
      .min(1)
      .default(10)
      .describe('Sessions a user can have at once. Signing in again ends the oldest.'),
  })
  .prefault({})
  .describe('Sessions.');

export const COUNTRY_CHANGE_POLICIES = ['challenge', 'block', 'notify', 'ignore'] as const;
export type CountryChangePolicy = (typeof COUNTRY_CHANGE_POLICIES)[number];

export const sessionSecurity = z
  .strictObject({
    on_country_change: z
      .enum(COUNTRY_CHANGE_POLICIES)
      .default('challenge')
      .describe(
        'When a session moves to another country: challenge drops it to aal0 until the user signs in again, block ends it, notify allows it and emails, ignore does nothing.',
      ),
    new_device_email: z
      .boolean()
      .default(true)
      .describe('Email the user when they sign in from a browser or OS that has not been seen.'),
    tls_fingerprint: z
      .strictObject({
        header: z
          .string()
          .min(1)
          .nullable()
          .default(null)
          .describe(
            'Request header holding a TLS fingerprint such as JA4. null turns this signal off.',
          ),
      })
      .prefault({})
      .describe('Optional TLS fingerprint from an upstream proxy.'),
    alert_min_interval: duration(
      '1h',
      'Shortest gap between security-alert emails to the same user.',
    ),
  })
  .prefault({})
  .describe('Session security checks.');

const bandStart = (band: string, value: number) =>
  z.int().min(1).max(150).default(value).describe(`Age the ${band} band starts at.`);

export const AGE_ASSURANCE_PROVIDERS = ['self_declared'] as const;
export type AgeAssuranceProviderId = (typeof AGE_ASSURANCE_PROVIDERS)[number];

export const AGE_ASSURANCE_TRIGGERS = ['claim_adult_band'] as const;
export type AgeAssuranceTrigger = (typeof AGE_ASSURANCE_TRIGGERS)[number];

export const age = z
  .strictObject({
    bands: z
      .strictObject({
        '13_to_15': bandStart('13_to_15', 13),
        '16_to_17': bandStart('16_to_17', 16),
        adult: bandStart('adult', 18),
      })
      .refine((b) => b['13_to_15'] < b['16_to_17'] && b['16_to_17'] < b.adult, {
        message: 'Each band must start at a greater age than the one before',
      })
      .prefault({})
      .describe('Age in whole years at which each band starts. Anyone younger is under_13.'),
    assurance: z
      .strictObject({
        default_provider: z
          .enum(AGE_ASSURANCE_PROVIDERS)
          .default('self_declared')
          .describe(
            'Provider used when a trigger in required_for applies. Only self_declared ships.',
          ),
        required_for: z
          .array(z.enum(AGE_ASSURANCE_TRIGGERS))
          .refine((triggers) => new Set(triggers).size === triggers.length, {
            message: 'Triggers must be unique',
          })
          .default([])
          .describe(
            'Triggers that need the default provider, such as claiming the adult band. Empty means a self-declared date of birth is enough.',
          ),
      })
      .prefault({})
      .describe('Pluggable age assurance.'),
  })
  .prefault({})
  .describe('Age bands, computed from the date of birth, and age assurance.');

export const parental = z
  .strictObject({
    consent_age: z
      .int()
      .min(1)
      .max(18)
      .default(13)
      .describe('Users younger than this need a parent or guardian to approve their account.'),
    pending_ttl: duration(
      '14d',
      'How long an unapproved child account waits for a parent or guardian. After this the account is deleted.',
    ),
    max_guardians: z
      .int()
      .min(1)
      .max(8)
      .default(2)
      .describe('How many parents or guardians a child account can have.'),
    graduation_grace: duration(
      '30d',
      'How long parental controls stay in place after the young person reaches consent_age. After this they can ask to remove the guardian link.',
    ),
  })
  .prefault({})
  .describe('Parental consent.');

export const USERNAME_MAX_LENGTH = 64;
const USERNAME_CHARSET = /^\[[^[\]]+\]$/;

function isUsernameCharset(value: string): boolean {
  if (!USERNAME_CHARSET.test(value)) return false;
  try {
    new RegExp(`^(?:${value})+$`, 'u');
    return true;
  } catch {
    return false;
  }
}

export const usernames = z
  .strictObject({
    min_length: z
      .int()
      .min(1)
      .max(USERNAME_MAX_LENGTH)
      .default(8)
      .describe('Shortest a username can be.'),
    max_length: z
      .int()
      .min(1)
      .max(USERNAME_MAX_LENGTH)
      .default(18)
      .describe('Longest a username can be.'),
    charset: z
      .string()
      .refine(isUsernameCharset, 'Must be a character class like [A-Za-z0-9_]')
      .default('[A-Za-z0-9_]')
      .describe('Allowed characters as a regex character class, e.g. [A-Za-z0-9_].'),
    reserved: z
      .array(z.string().min(1).max(USERNAME_MAX_LENGTH))
      .default([])
      .describe('Usernames nobody can claim. Compared without regard to case. Empty by default.'),
    reserved_prefixes: z
      .array(z.string().min(1).max(USERNAME_MAX_LENGTH))
      .default([])
      .describe(
        'Username prefixes nobody can claim, such as a brand prefix. Compared without regard to case. Empty by default.',
      ),
    change_cooldown: duration(
      '30d',
      'How long a user must wait after claiming or changing a username before changing it again.',
    ),
    changes_per_year: z
      .int()
      .min(0)
      .default(3)
      .describe(
        'How many times a user can change their username inside change_window, after the first claim.',
      ),
    change_window: duration(
      '365d',
      'Window used to count username changes against changes_per_year.',
    ),
    release_hold: duration(
      '90d',
      'How long a released username is held for the previous owner before anyone else can claim it.',
    ),
  })
  .refine((value) => value.max_length >= value.min_length, {
    message: 'Must be at least min_length',
    path: ['max_length'],
  })
  .prefault({})
  .describe('Usernames.');

export const legal = z
  .strictObject({
    public_history: z
      .boolean()
      .default(true)
      .describe('Previous versions are publicly viewable at /legal/<id>/<version>.'),
    documents_dir: z
      .string()
      .min(1)
      .default('legal')
      .describe(
        'Markdown documents with YAML front-matter, relative to the config file. Identity syncs them into the database on startup.',
      ),
  })
  .prefault({})
  .describe('Legal documents and re-acceptance.');

export const SAFETY_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type SafetyPriority = (typeof SAFETY_PRIORITIES)[number];

export const SAFETY_TAXONOMY_ID = /^[a-z][a-z0-9_]*$/;
export const SAFETY_TAXONOMY_ID_MESSAGE = 'Must be a lowercase slug like hate_speech';
export const SAFETY_LABEL_MAX = 80;
export const SAFETY_NOTE_MAX = 2_000;
export const SAFETY_SNAPSHOT_MAX = 65_536;
export const SAFETY_CLASSIFIER_MAX = 80;
export const SAFETY_PERSON_MAX = 120;
export const SAFETY_NCA_REFERENCE_MAX = 80;
export const CSEA_NCA_PRIORITIES = [1, 2, 3] as const;
export type CseaNcaPriority = (typeof CSEA_NCA_PRIORITIES)[number];

const safetySubtype = z
  .strictObject({
    id: z
      .string()
      .regex(SAFETY_TAXONOMY_ID, SAFETY_TAXONOMY_ID_MESSAGE)
      .describe('Subtype slug, unique within the type.'),
    name: z
      .string()
      .trim()
      .min(1)
      .max(SAFETY_LABEL_MAX)
      .describe('Subtype name shown to reporters and moderators.'),
  })
  .describe('A reason subtype under a report type.');

const safetyType = z
  .strictObject({
    name: z
      .string()
      .trim()
      .min(1)
      .max(SAFETY_LABEL_MAX)
      .describe('Type name shown to reporters and moderators.'),
    subtypes: z
      .array(safetySubtype)
      .min(1)
      .refine((list) => new Set(list.map((s) => s.id)).size === list.length, {
        message: 'Subtype ids must be unique within a type',
      })
      .describe('Subtypes offered to reporters when they pick this type.'),
    default_priority: z
      .enum(SAFETY_PRIORITIES)
      .default('normal')
      .describe('Priority the report enters the queue with.'),
    sla: requiredDuration('Time-to-first-action target for reports of this type.'),
    csea: z
      .boolean()
      .default(false)
      .describe(
        'Opens a CSEA case, restricting access, evidence preservation and NCA workflow. Never delivered to webhooks, email bodies or logs.',
      ),
  })
  .describe('A report type in the taxonomy.');

const DEFAULT_SAFETY_TAXONOMY = {
  csea: {
    name: 'Child sexual exploitation and abuse',
    default_priority: 'urgent',
    sla: '1h',
    csea: true,
    subtypes: [
      { id: 'csam', name: 'Child sexual abuse material' },
      { id: 'grooming', name: 'Grooming or solicitation of a child' },
      { id: 'sexual_extortion', name: 'Sexual extortion of a child' },
    ],
  },
  terrorism: {
    name: 'Terrorism',
    default_priority: 'urgent',
    sla: '1h',
    csea: false,
    subtypes: [
      { id: 'propaganda', name: 'Terrorist propaganda or glorification' },
      { id: 'recruitment', name: 'Recruitment to a terrorist organisation' },
      { id: 'planning', name: 'Planning of a terrorist act' },
    ],
  },
  violence: {
    name: 'Violence and credible threats',
    default_priority: 'high',
    sla: '24h',
    csea: false,
    subtypes: [
      { id: 'threats', name: 'Threats of violence' },
      { id: 'incitement', name: 'Incitement to violence' },
      { id: 'graphic_violence', name: 'Graphic violence or gore' },
    ],
  },
  self_harm: {
    name: 'Suicide and self-harm',
    default_priority: 'high',
    sla: '24h',
    csea: false,
    subtypes: [
      { id: 'encouragement', name: 'Encouragement of suicide or self-harm' },
      { id: 'method_sharing', name: 'Sharing of methods' },
      { id: 'graphic_self_harm', name: 'Graphic self-harm imagery' },
    ],
  },
  hate: {
    name: 'Hate and harassment',
    default_priority: 'normal',
    sla: '24h',
    csea: false,
    subtypes: [
      { id: 'protected_characteristic', name: 'Hate against a protected characteristic' },
      { id: 'targeted_harassment', name: 'Targeted harassment of an individual' },
      { id: 'unwanted_contact', name: 'Unwanted contact after being asked to stop' },
    ],
  },
  sexual: {
    name: 'Sexual content involving adults',
    default_priority: 'normal',
    sla: '24h',
    csea: false,
    subtypes: [
      { id: 'non_consensual', name: 'Intimate image shared without consent' },
      { id: 'adult_content', name: 'Sexual content outside a permitted space' },
    ],
  },
  fraud: {
    name: 'Fraud and scams',
    default_priority: 'normal',
    sla: '24h',
    csea: false,
    subtypes: [
      { id: 'phishing', name: 'Phishing or account theft' },
      { id: 'financial_scam', name: 'Financial scam' },
      { id: 'impersonation', name: 'Impersonation of a person or brand' },
    ],
  },
  illegal_goods: {
    name: 'Illegal goods and controlled items',
    default_priority: 'normal',
    sla: '24h',
    csea: false,
    subtypes: [
      { id: 'drugs', name: 'Drugs' },
      { id: 'weapons', name: 'Weapons' },
      { id: 'stolen_goods', name: 'Stolen goods or credentials' },
    ],
  },
  other: {
    name: 'Other rule violation',
    default_priority: 'normal',
    sla: '24h',
    csea: false,
    subtypes: [
      { id: 'spam', name: 'Spam or repeated low-quality content' },
      { id: 'under_age', name: 'Account holder appears under-age' },
      { id: 'privacy', name: "Someone else's private information" },
      { id: 'other', name: 'Something else' },
    ],
  },
} as const;

export const SAFETY_ACTIONS = [
  'warn',
  'restrict',
  'force_username_reset',
  'lock',
  'ban',
  'remove_content',
  'proscribed_org_removal',
] as const;
export type SafetyActionType = (typeof SAFETY_ACTIONS)[number];

export const SAFETY_RESTRICTIONS = ['chat', 'ugc', 'username_change'] as const;
export type SafetyRestriction = (typeof SAFETY_RESTRICTIONS)[number];

export const SAFETY_SUMMARY_MAX = 500;
export const SAFETY_APPEAL_MAX = SAFETY_NOTE_MAX;

const safetyAction = z
  .strictObject({
    name: z
      .string()
      .trim()
      .min(1)
      .max(SAFETY_LABEL_MAX)
      .describe('Action name shown to staff and in the statement of reasons.'),
    enabled: z.boolean().default(true).describe('Staff can apply this action.'),
  })
  .describe('A moderation action type.');

const DEFAULT_SAFETY_ACTIONS = {
  warn: { name: 'Warn' },
  restrict: { name: 'Restrict' },
  force_username_reset: { name: 'Force username reset' },
  lock: { name: 'Lock' },
  ban: { name: 'Ban' },
  remove_content: { name: 'Remove content' },
  proscribed_org_removal: { name: 'Proscribed organisation removal' },
} as const;

const safetyRule = z
  .strictObject({
    name: z
      .string()
      .trim()
      .min(1)
      .max(SAFETY_LABEL_MAX)
      .describe('Rule name shown to staff and in the statement of reasons.'),
    summary: z
      .string()
      .trim()
      .min(1)
      .max(SAFETY_SUMMARY_MAX)
      .describe('Short explanation of the rule, sent to the user with the action.'),
  })
  .describe('A rule staff must select to apply an enforcement action.');

const DEFAULT_SAFETY_RULES = {
  community_standards: {
    name: 'Community standards',
    summary: 'This broke the community standards.',
  },
  hate: {
    name: 'Hate and harassment',
    summary: 'Hate or harassment of other people is not allowed.',
  },
  violence: {
    name: 'Violence and credible threats',
    summary: 'Violence, threats of violence and incitement are not allowed.',
  },
  self_harm: {
    name: 'Suicide and self-harm',
    summary: 'Content that encourages suicide or self-harm is not allowed.',
  },
  sexual: {
    name: 'Sexual content',
    summary: 'This sexual content is not allowed here.',
  },
  fraud: {
    name: 'Fraud and scams',
    summary: 'Fraud, phishing and scams are not allowed.',
  },
  illegal_goods: {
    name: 'Illegal goods',
    summary: 'Selling or sharing illegal goods is not allowed.',
  },
  terrorism: {
    name: 'Terrorism',
    summary: 'Terrorist content and recruitment are not allowed.',
  },
  proscribed_organisation: {
    name: 'Proscribed organisation',
    summary: 'Content that supports a proscribed organisation is not allowed.',
  },
  other: {
    name: 'Other rule violation',
    summary: 'This broke the rules.',
  },
  protective: {
    name: 'Immediate protective action',
    summary: 'An urgent restriction was applied while a report is reviewed.',
  },
} as const;

export const safety = z
  .strictObject({
    reports: z
      .strictObject({
        reporter_ack: z
          .boolean()
          .default(true)
          .describe('Email the reporter to acknowledge receipt when they gave an email address.'),
        reporter_outcome: z
          .boolean()
          .default(true)
          .describe(
            'Email the reporter with the outcome once a moderator acts on the report. Reporters are never identified to the reported user.',
          ),
        default_priority: z
          .enum(SAFETY_PRIORITIES)
          .default('normal')
          .describe("Priority when a type's default_priority is not overridden."),
        max_note_length: z
          .int()
          .min(1)
          .max(SAFETY_NOTE_MAX)
          .default(SAFETY_NOTE_MAX)
          .describe('Longest note a reporter can attach to a report.'),
        max_snapshot_bytes: z
          .int()
          .min(1)
          .max(SAFETY_SNAPSHOT_MAX)
          .default(SAFETY_SNAPSHOT_MAX)
          .describe('Longest content snapshot, in bytes, accepted on intake.'),
        sla_check_interval: duration(
          '1m',
          'How often the SLA sweep runs. sla_breached events are emitted at most once per report.',
        ),
      })
      .prefault({})
      .describe('Reporting behaviour.'),
    taxonomy: z
      .strictObject({
        types: z
          .record(z.string().regex(SAFETY_TAXONOMY_ID, SAFETY_TAXONOMY_ID_MESSAGE), safetyType)
          .default({})
          .transform((types) => {
            const merged = z.record(z.string(), safetyType).parse(DEFAULT_SAFETY_TAXONOMY);
            for (const [id, type] of Object.entries(types)) merged[id] = type;
            return merged;
          })
          .describe(
            'Report types. Ids you set replace the built-in type of the same name, and other built-in types stay as they are.',
          ),
      })
      .prefault({})
      .describe('Report taxonomy: types, subtypes, priorities, SLAs and CSEA flags.'),
    csea_alert_emails: z
      .array(z.email())
      .default([])
      .refine((list) => new Set(list).size === list.length, {
        message: 'Alert email addresses must be unique',
      })
      .describe(
        'Recipients of the alert-only notification that a CSEA case exists. Bodies never contain case content.',
      ),
    csea: z
      .strictObject({
        encryption_key: z
          .string()
          .default('')
          .describe(
            'Base64 32-byte key that encrypts CSEA evidence at rest. Required when CSEA is enabled. Reference a secret.',
          ),
        nca_portal_url: z
          .string()
          .default('')
          .refine(
            (value) => {
              if (value === '') return true;
              try {
                const url = new URL(value);
                return url.protocol === 'https:' || url.protocol === 'http:';
              } catch {
                return false;
              }
            },
            { message: 'Must be an http or https URL' },
          )
          .describe(
            'URL of the NCA CSEA-IRP portal, shown to staff as the submission destination. Empty until the operator registers.',
          ),
        protective_lock: duration(
          '7d',
          'How long a one-click protective lock lasts. Staff can lift it earlier.',
        ),
        priority_1: duration(
          '15m',
          "NCA submission window for priority 1 (immediate threat to a child's life or serious harm). SI 2026/268 says immediately.",
        ),
        priority_2: duration(
          '4h',
          'NCA submission window for priority 2 (risk of serious harm in the near future). SI 2026/268 says as soon as reasonably practicable.',
        ),
        priority_3: duration(
          '24h',
          'NCA submission window for priority 3. SI 2026/268 says without undue delay.',
        ),
      })
      .prefault({})
      .describe('CSEA / NCA reporting workflow (SI 2026/268).'),
    accountable_person: z
      .strictObject({
        name: z
          .string()
          .trim()
          .max(SAFETY_PERSON_MAX)
          .default('')
          .describe('Name of the person accountable for compliance with the OSA safety duties.'),
        role: z
          .string()
          .trim()
          .max(SAFETY_PERSON_MAX)
          .default('')
          .describe('Their role, shown to legal document templates and in the admin UI.'),
      })
      .prefault({})
      .describe('Accountable person for the OSA safety duties (ICU A2).'),
    actions: z
      .strictObject({
        types: z
          .record(z.string().regex(SAFETY_TAXONOMY_ID, SAFETY_TAXONOMY_ID_MESSAGE), safetyAction)
          .default({})
          .transform((types) => {
            const merged = z.record(z.string(), safetyAction).parse(DEFAULT_SAFETY_ACTIONS);
            for (const [id, action] of Object.entries(types)) merged[id] = action;
            return merged;
          })
          .describe(
            'Moderation actions. Ids you set replace the built-in action of the same name, and other built-in actions stay as they are.',
          ),
      })
      .prefault({})
      .describe('Config-defined moderation actions and whether each is available to staff.'),
    rules: z
      .strictObject({
        items: z
          .record(z.string().regex(SAFETY_TAXONOMY_ID, SAFETY_TAXONOMY_ID_MESSAGE), safetyRule)
          .default({})
          .transform((items) => {
            const merged = z.record(z.string(), safetyRule).parse(DEFAULT_SAFETY_RULES);
            for (const [id, rule] of Object.entries(items)) merged[id] = rule;
            return merged;
          })
          .describe(
            'Rules staff must choose from for a statement of reasons. Ids you set replace the built-in rule of the same name.',
          ),
      })
      .prefault({})
      .describe('Rules offered when applying an enforcement action.'),
    restrictions: z
      .array(z.string().regex(SAFETY_TAXONOMY_ID, SAFETY_TAXONOMY_ID_MESSAGE))
      .default([...SAFETY_RESTRICTIONS])
      .refine((list) => new Set(list).size === list.length, {
        message: 'Restriction ids must be unique',
      })
      .describe(
        'Named restrictions a restrict action may apply, such as chat, ugc and username_change. Exposed on the identity token.',
      ),
    bans: z
      .strictObject({
        require_second_approval: z
          .boolean()
          .default(false)
          .describe(
            'Permanent bans and proscribed-organisation removals need a second, different moderator to take effect.',
          ),
      })
      .prefault({})
      .describe('Ban policy.'),
    appeals: z
      .strictObject({
        max_length: z
          .int()
          .min(1)
          .max(SAFETY_APPEAL_MAX)
          .default(SAFETY_APPEAL_MAX)
          .describe('Longest appeal a user can submit.'),
      })
      .prefault({})
      .describe('Appeals against locks, bans and restrictions.'),
  })
  .prefault({})
  .describe('Safety module (safety profile): reporting, moderation, CSEA workflow.');

export const SUPPORT_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type SupportPriority = (typeof SUPPORT_PRIORITIES)[number];

export const SUPPORT_CATEGORY_ID = SAFETY_TAXONOMY_ID;
export const SUPPORT_CATEGORY_ID_MESSAGE = 'Must be a lowercase slug like account';
export const SUPPORT_LABEL_MAX = 80;
export const SUPPORT_SUBJECT_MAX = 200;
export const SUPPORT_BODY_MAX = 8_000;
export const SUPPORT_NOTE_MAX = SUPPORT_BODY_MAX;
export const SUPPORT_MACRO_NAME_MAX = 80;

const ticketCategory = z
  .strictObject({
    name: z
      .string()
      .trim()
      .min(1)
      .max(SUPPORT_LABEL_MAX)
      .describe('Name shown to users and staff.'),
    guest_allowed: z
      .boolean()
      .default(false)
      .describe('Allow signed-out users to open tickets in this category (guest tickets).'),
    appeal: z
      .boolean()
      .default(false)
      .describe(
        'Use this category for appeals from banned or locked accounts. Exactly one category must be an appeal category.',
      ),
  })
  .describe('A support ticket category.');

const DEFAULT_TICKET_CATEGORIES = {
  account: { name: 'Account', guest_allowed: false, appeal: false },
  billing: { name: 'Billing', guest_allowed: true, appeal: false },
  technical: { name: 'Technical', guest_allowed: true, appeal: false },
  other: { name: 'Other', guest_allowed: true, appeal: false },
  appeal: { name: 'Appeal', guest_allowed: false, appeal: true },
} as const;

export const support = z
  .strictObject({
    auto_close_after: duration(
      '7d',
      'Close tickets waiting on the user after this long. A reminder is sent at the halfway point.',
    ),
    max_subject_length: z
      .int()
      .min(1)
      .max(SUPPORT_SUBJECT_MAX)
      .default(SUPPORT_SUBJECT_MAX)
      .describe('Longest ticket subject.'),
    max_body_length: z
      .int()
      .min(1)
      .max(SUPPORT_BODY_MAX)
      .default(SUPPORT_BODY_MAX)
      .describe('Longest ticket body, reply or internal note.'),
    guest_code_ttl: duration(
      '15m',
      'An emailed guest-ticket code works for this long. A newer code replaces an unused one.',
    ),
    guest_link_ttl: duration(
      '7d',
      'A guest magic link works for this long. Later emails send a new link, and older links keep working until they expire.',
    ),
    attachment_max_bytes: z
      .int()
      .min(1)
      .max(50_000_000)
      .default(524_288)
      .describe(
        'Largest ticket attachment, in bytes. The upload is base64 in JSON, so gateway.http.max_body_size must be about a third larger than this.',
      ),
    attachment_download_ttl: duration(
      '15m',
      'A signed attachment download link works for this long. Downloads are sent as attachments, never displayed inline.',
    ),
    categories: z
      .record(z.string().regex(SUPPORT_CATEGORY_ID, SUPPORT_CATEGORY_ID_MESSAGE), ticketCategory)
      .default({})
      .transform((categories) => {
        const merged = z.record(z.string(), ticketCategory).parse(DEFAULT_TICKET_CATEGORIES);
        for (const [id, category] of Object.entries(categories)) merged[id] = category;
        return merged;
      })
      .refine(
        (categories) =>
          Object.values(categories).filter((category) => category.appeal).length === 1,
        { message: 'Exactly one category must be marked appeal' },
      )
      .describe(
        'Ticket categories. Ids you set replace the built-in category of the same name, and other built-in categories stay as they are. Exactly one must have appeal: true.',
      ),
  })
  .prefault({})
  .describe('Support module (support profile): tickets and knowledge base.');

export const OIDC_SIGNING_ALGORITHMS = ['ES256', 'RS256'] as const;
export type OidcSigningAlgorithm = (typeof OIDC_SIGNING_ALGORITHMS)[number];

export const LICENSE_SIGNING_ALGORITHMS = ['EdDSA', 'ES256', 'RS256'] as const;
export type LicenseSigningAlgorithm = (typeof LICENSE_SIGNING_ALGORITHMS)[number];

export const OIDC_CLIENT_TYPES = ['public', 'confidential'] as const;
export type OidcClientType = (typeof OIDC_CLIENT_TYPES)[number];

export const OIDC_SCOPE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/;
export const OIDC_SCOPE_MESSAGE = 'Must be a scope like openid or achievements.write';
export const OIDC_CLIENT_ID = /^[A-Za-z0-9._~-]{1,64}$/;
export const OIDC_CLIENT_ID_MESSAGE = 'Must be 1–64 letters, digits, ., _, ~ or -';
export const OIDC_CLIENT_NAME_MAX = 80;
export const OIDC_CLIENT_DESCRIPTION_MAX = 200;
export const OIDC_CLAIM = /^[a-z][a-z0-9_]*$/;

export const DEFAULT_OIDC_SCOPES = {
  openid: { consent: 'Sign you in', claims: [] as string[] },
  profile: {
    consent: 'See your username',
    claims: ['preferred_username', 'username_updated_at'],
  },
  email: { consent: 'See your email address', claims: ['email', 'email_verified'] },
  offline_access: {
    consent: 'Stay signed in when you are not using the app',
    claims: [] as string[],
  },
  age: { consent: 'See your age band', claims: ['age_band', 'age_assurance_strength'] },
  parental_controls: {
    consent: 'See parental controls on this account',
    claims: ['parental_controls'],
  },
  restrictions: { consent: 'See restrictions on this account', claims: ['restrictions'] },
  games: { consent: 'See which games you own', claims: [] as string[] },
  achievements: { consent: 'See your achievements', claims: [] as string[] },
  'achievements.write': {
    consent: 'Unlock achievements and update progress in this game',
    claims: [] as string[],
  },
  game_stats: { consent: 'See your game stats', claims: [] as string[] },
  'game_stats.write': {
    consent: 'Record stats and playtime for this game',
    claims: [] as string[],
  },
  game_server: {
    consent: 'Act as a game server on your behalf',
    claims: [] as string[],
  },
  'games.entitlements.write': {
    consent: 'Grant and revoke game products on this account',
    claims: [] as string[],
  },
} as const;

export const GAME_SERVER_SCOPE = 'game_server';
export const GAMES_ENTITLEMENTS_WRITE_SCOPE = 'games.entitlements.write';
export const ACHIEVEMENTS_WRITE_SCOPE = 'achievements.write';
export const GAME_STATS_WRITE_SCOPE = 'game_stats.write';

export const GAME_CLIENT_ONLY_SCOPES: readonly string[] = [
  ACHIEVEMENTS_WRITE_SCOPE,
  GAME_STATS_WRITE_SCOPE,
];

const oidcScope = z
  .strictObject({
    consent: z.string().min(1).describe('Text shown on the consent screen for this scope.'),
    claims: z
      .array(z.string().regex(OIDC_CLAIM, 'Must be a claim like email or age_band'))
      .default([])
      .describe('ID token and userinfo claims this scope releases.'),
  })
  .describe('An OAuth scope and the claims it releases.');

function isLoopbackHost(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

function isRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username !== '' || url.password !== '' || url.hash !== '') return false;
    if (isLoopbackHost(url.hostname)) return url.protocol === 'http:';
    return url.protocol === 'https:';
  } catch {
    return false;
  }
}

const oidcClient = z
  .strictObject({
    name: z.string().min(1).max(OIDC_CLIENT_NAME_MAX).describe('Name shown on the consent screen.'),
    type: z
      .enum(OIDC_CLIENT_TYPES)
      .describe('public clients have no secret. confidential clients do.'),
    first_party: z
      .boolean()
      .default(false)
      .describe('Skip the consent screen. For the first-party web app and other in-house clients.'),
    verified: z
      .boolean()
      .default(false)
      .describe(
        'Show a verified badge on the consent screen. First-party clients are treated as verified.',
      ),
    redirect_uris: z
      .array(
        z.string().refine(isRedirectUri, 'Must be an https URL, or http on 127.0.0.1 or [::1]'),
      )
      .default([])
      .describe(
        'Exact-match redirect URIs. Empty for clients that only use the device flow or client credentials. Native apps may register a loopback URI; any port is accepted at authorize time.',
      ),
    allowed_scopes: z
      .array(z.string().regex(OIDC_SCOPE, OIDC_SCOPE_MESSAGE))
      .nullable()
      .default(null)
      .describe('Scopes this client may request. null allows every configured scope.'),
    require_par: z
      .boolean()
      .default(false)
      .describe('Require Pushed Authorization Requests (RFC 9126) for this client.'),
    backchannel_logout_uri: z
      .string()
      .refine(isRedirectUri, 'Must be an https URL, or http on 127.0.0.1 or [::1]')
      .nullable()
      .default(null)
      .describe(
        'OpenID Connect back-channel logout URI. The provider POSTs a logout token here when a session ends.',
      ),
    backchannel_logout_session_required: z
      .boolean()
      .default(false)
      .describe('Require sid in logout tokens sent to this client.'),
    secret: z
      .string()
      .default('')
      .describe(
        'Client secret for confidential clients. Empty for public clients. Reference a secret.',
      ),
  })
  .refine((client) => client.type === 'public' || client.secret !== '', {
    message: 'Required for confidential clients',
    path: ['secret'],
  })
  .describe(
    'A seeded OAuth client. Existing client_ids are left as they are after the first start.',
  );

export const oidc = z
  .strictObject({
    issuer: z
      .url({ protocol: /^https?$/ })
      .nullable()
      .default(null)
      .describe(
        'Issuer URL advertised in discovery and used as JWT iss. null uses the api surface origin.',
      ),
    resource: z
      .string()
      .min(1)
      .nullable()
      .default(null)
      .describe(
        'Access token audience (RFC 9068). null uses the issuer. Gateway oauth routes require this audience.',
      ),
    signing: z
      .strictObject({
        algorithm: z
          .enum(OIDC_SIGNING_ALGORITHMS)
          .default('ES256')
          .describe('ID and access token signing algorithm. RS256 or ES256.'),
        encryption_key: z
          .string()
          .default('')
          .describe(
            'Base64 32-byte key that encrypts the signing keys at rest. Required to start oidc. Reference a secret.',
          ),
        rotate_after: duration('90d', 'Replace the signing key once it is this old.'),
        retain_after_rotation: duration(
          '1h',
          'Keep publishing a replaced key for this long, so tokens it signed can still be checked.',
        ),
        refresh: duration(
          '30s',
          'Reload signing keys from the store this often, so other oidc replicas pick up a rotation.',
        ),
      })
      .prefault({})
      .describe('Signing keys for ID tokens, access tokens and logout tokens.'),
    authorization_code_ttl: duration('1m', 'How long an authorization code can be exchanged.'),
    access_ttl: duration('15m', 'Access token lifetime.'),
    id_ttl: duration('15m', 'ID token lifetime.'),
    refresh_ttl: duration('30d', 'Refresh token lifetime. Rotated on every use.'),
    device_code_ttl: duration('15m', 'How long a device-flow code can be approved and exchanged.'),
    device_interval: duration(
      '5s',
      'Minimum time a device-flow client must wait between token polls.',
    ),
    pushed_authorization_ttl: duration(
      '1m',
      'How long a pushed authorization request_uri can be used at the authorize endpoint.',
    ),
    logout: z
      .strictObject({
        timeout: duration(
          '10s',
          'Give up on a back-channel logout POST when the client is quiet for this long.',
        ),
        retry_window: duration(
          '24h',
          'Keep retrying a failed back-channel logout delivery for this long, then mark it failed.',
        ),
        retry_delay: duration(
          '1m',
          'Delay before the first back-channel logout retry. Doubles with each attempt.',
        ),
        max_retry_delay: duration('1h', 'Longest delay between back-channel logout retries.'),
        allow_private_targets: z
          .boolean()
          .default(false)
          .describe(
            'Allow logout URIs whose DNS resolves to private, loopback or link-local addresses. Loopback http URIs on 127.0.0.1 or [::1] are always allowed.',
          ),
      })
      .refine((value) => value.max_retry_delay >= value.retry_delay, {
        message: 'Must be at least retry_delay',
        path: ['max_retry_delay'],
      })
      .prefault({})
      .describe('Back-channel logout delivery.'),
    developer_portal: z
      .strictObject({
        max_clients_per_user: z
          .int()
          .min(1)
          .max(1000)
          .default(10)
          .describe('How many OAuth clients a user may register.'),
      })
      .prefault({})
      .describe('Developer portal limits.'),
    scopes: z
      .record(z.string().regex(OIDC_SCOPE, OIDC_SCOPE_MESSAGE), oidcScope)
      .default({})
      .transform((scopes) => ({
        ...Object.fromEntries(
          Object.entries(DEFAULT_OIDC_SCOPES).map(([name, scope]) => [
            name,
            { consent: scope.consent, claims: [...scope.claims] },
          ]),
        ),
        ...scopes,
      }))
      .describe(
        'Scopes and the claims they release. Built-in scopes stay unless you replace them. Add extra scopes here.',
      ),
    clients: z
      .record(z.string().regex(OIDC_CLIENT_ID, OIDC_CLIENT_ID_MESSAGE), oidcClient)
      .default({})
      .describe(
        'Clients to seed on startup, keyed by client_id. Existing client_ids are left as they are; manage them in the developer portal after that.',
      ),
  })
  .superRefine((value, ctx) => {
    const retain = value.signing.retain_after_rotation;
    if (retain < value.access_ttl) {
      ctx.addIssue({
        code: 'custom',
        message: 'Must be at least access_ttl, so replaced keys can still verify live tokens',
        path: ['signing', 'retain_after_rotation'],
      });
    }
    if (retain < value.id_ttl) {
      ctx.addIssue({
        code: 'custom',
        message: 'Must be at least id_ttl, so replaced keys can still verify live tokens',
        path: ['signing', 'retain_after_rotation'],
      });
    }
    const known = new Set(Object.keys(value.scopes));
    for (const [id, client] of Object.entries(value.clients)) {
      const uris = client.redirect_uris;
      if (new Set(uris).size !== uris.length) {
        ctx.addIssue({
          code: 'custom',
          message: 'Redirect URIs must be unique',
          path: ['clients', id, 'redirect_uris'],
        });
      }
      for (const [index, scope] of (client.allowed_scopes ?? []).entries()) {
        if (!known.has(scope)) {
          ctx.addIssue({
            code: 'custom',
            message: 'Must name a configured scope',
            path: ['clients', id, 'allowed_scopes', index],
          });
        }
      }
    }
  })
  .prefault({})
  .describe('OIDC provider: keys, token lifetimes, scopes and seeded clients.');

export const GAME_STATUSES = ['draft', 'hidden', 'early_access', 'released', 'archived'] as const;
export type GameStatus = (typeof GAME_STATUSES)[number];

export const PRODUCT_TYPES = ['base', 'dlc', 'edition', 'beta_access', 'soundtrack'] as const;
export type ProductType = (typeof PRODUCT_TYPES)[number];

export const ENTITLEMENT_SOURCES = ['admin_grant', 'key_redemption', 'steam', 'api'] as const;
export type EntitlementSource = (typeof ENTITLEMENT_SOURCES)[number];

export const GAME_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export const GAME_SLUG_MESSAGE = 'Must be a lowercase slug like my-game';
export const GAME_NAME_MAX = 120;
export const GAME_DESCRIPTION_MAX = 4_000;
export const GAME_ART_MAX = 500;
export const GAME_REVOKE_REASON_MAX = 500;
export const GAME_KEY_LABEL_MAX = 80;
export const GAME_ACHIEVEMENT_NAME_MAX = 120;
export const GAME_ACHIEVEMENT_DESCRIPTION_MAX = 500;
export const GAME_KEY_CHARSET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const GAME_KEY_CHARSET_MESSAGE =
  'Must be at least eight distinct ASCII characters and no whitespace';

function isKeyCharset(value: string): boolean {
  if (value.length < 8) return false;
  if (/\s/.test(value)) return false;
  return new Set(value).size === value.length;
}

export const games = z
  .strictObject({
    default_lease_duration: duration(
      '20d',
      'Default offline-play lease duration for a game that does not set its own.',
    ),
    default_cloud_save_quota_bytes: z
      .int()
      .min(0)
      .max(1_099_511_627_776)
      .default(104_857_600)
      .describe('Default cloud-save quota per user per game, in bytes.'),
    server_client_name_suffix: z
      .string()
      .trim()
      .min(1)
      .max(OIDC_CLIENT_NAME_MAX)
      .default('server')
      .describe(
        'Suffix used to name a game server client, joined to the game name with a space. Kept short so the full client name stays within the limit.',
      ),
    keys: z
      .strictObject({
        charset: z
          .string()
          .refine(isKeyCharset, GAME_KEY_CHARSET_MESSAGE)
          .default(GAME_KEY_CHARSET)
          .describe(
            'Characters used to generate keys. Distinct, no whitespace. The default is Crockford-flavoured, without letters that look like digits.',
          ),
        group_length: z
          .int()
          .min(3)
          .max(12)
          .default(4)
          .describe('Number of characters per hyphen-separated group.'),
        groups: z.int().min(2).max(8).default(4).describe('Number of groups per key.'),
        max_batch: z
          .int()
          .min(1)
          .max(1_000_000)
          .default(10_000)
          .describe('Largest batch that can be generated in one call.'),
      })
      .prefault({})
      .describe('Key redemption defaults and limits.'),
    licensing: z
      .strictObject({
        signing: z
          .strictObject({
            algorithm: z
              .enum(LICENSE_SIGNING_ALGORITHMS)
              .default('EdDSA')
              .describe(
                'Lease signing algorithm. EdDSA is smallest and fastest for offline verification.',
              ),
            rotate_after: duration('90d', 'Replace the licensing signing key once it is this old.'),
            retain_after_rotation: duration(
              '30d',
              'Keep publishing a replaced licensing key for this long, so leases it signed can still be checked offline.',
            ),
            refresh: duration(
              '30s',
              'Reload licensing keys from the store this often, so other games replicas pick up a rotation.',
            ),
          })
          .prefault({})
          .describe(
            'Dedicated signing keys for offline licensing leases, separate from the OIDC key set.',
          ),
        max_devices: z
          .int()
          .min(1)
          .max(1_000)
          .default(5)
          .describe(
            'How many devices a user may bind concurrently per game when device binding is on.',
          ),
        revocation_list_ttl: duration(
          '5m',
          'How long a signed revocation list is fresh for. Clients may cache it for this long.',
        ),
      })
      .prefault({})
      .describe('Offline licensing: signed leases proving ownership for offline play.'),
  })
  .prefault({})
  .describe('Games module (games profile): catalog, products, entitlements and keys.');

const CRON_JOB_NAME = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/;

function isCronPattern(value: string): boolean {
  try {
    new Cron(value, { timezone: 'UTC', paused: true }).nextRun();
    return true;
  } catch {
    return false;
  }
}

function isTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const cronJob = z
  .strictObject({
    schedule: z
      .string()
      .refine(isCronPattern, 'Must be a cron pattern like 0 3 * * *')
      .optional()
      .describe(
        'When the job runs, as a cron pattern: minute, hour, day of month, month and day of week, with an optional seconds field first. Required for jobs that are not built in.',
      ),
    enabled: z.boolean().default(true).describe('Publish ticks for this job.'),
  })
  .describe('A scheduled job.');

export interface CronJob {
  schedule: string;
  enabled: boolean;
}

const DEFAULT_CRON_JOBS: Record<string, CronJob> = {
  'retention.sweep': { schedule: '0 3 * * *', enabled: true },
  'parental.expire_pending': { schedule: '0 * * * *', enabled: true },
  'parental.activity_summary': { schedule: '0 8 * * 1', enabled: true },
  'parental.graduation': { schedule: '10 0 * * *', enabled: true },
  'parental.removal_reminders': { schedule: '0 9 * * 1', enabled: true },
  'accounts.purge_deleted': { schedule: '30 3 * * *', enabled: true },
  'age.recompute_bands': { schedule: '5 0 * * *', enabled: true },
  'accounts.unlock_expired': { schedule: '* * * * *', enabled: true },
  'legal.publish': { schedule: '* * * * *', enabled: true },
  'accounts.resume_exports': { schedule: '*/5 * * * *', enabled: true },
  'deletion_ledger.prune': { schedule: '0 4 * * *', enabled: true },
  'keys.rotate': { schedule: '0 0 * * *', enabled: true },
  'webhooks.retry': { schedule: '* * * * *', enabled: true },
  'oidc.logout.retry': { schedule: '* * * * *', enabled: true },
  'support.auto_close': { schedule: '0 * * * *', enabled: true },
  'safety.sla_sweep': { schedule: '* * * * *', enabled: true },
  'safety.csea_retention': { schedule: '15 3 * * *', enabled: true },
  'achievements.recompute_rarity': { schedule: '0 2 * * *', enabled: true },
  'leaderboards.reset_periodic': { schedule: '* * * * *', enabled: true },
  'steam.ownership_sync': { schedule: '0 5 * * *', enabled: true },
  'games.expire_entitlements': { schedule: '*/5 * * * *', enabled: true },
  'backup.run': { schedule: '30 2 * * *', enabled: true },
};

export const scheduler = z
  .strictObject({
    timezone: z
      .string()
      .refine(isTimezone, 'Must be an IANA time zone like UTC or Europe/London')
      .default('UTC')
      .describe('Time zone the job schedules are written in.'),
    jobs: z
      .record(z.string().regex(CRON_JOB_NAME, 'Must be a job name like retention.sweep'), cronJob)
      .default({})
      .superRefine((jobs, ctx) => {
        for (const [name, job] of Object.entries(jobs)) {
          if (job.schedule === undefined && !(name in DEFAULT_CRON_JOBS)) {
            ctx.addIssue({
              code: 'custom',
              message: 'Required for a job that is not built in',
              path: [name, 'schedule'],
            });
          }
        }
      })
      .transform((jobs): Record<string, CronJob> => {
        const merged = { ...DEFAULT_CRON_JOBS };
        for (const [name, job] of Object.entries(jobs)) {
          const schedule = job.schedule ?? DEFAULT_CRON_JOBS[name]?.schedule ?? '';
          merged[name] = { schedule, enabled: job.enabled };
        }
        return merged;
      })
      .describe(
        'Jobs published on qtiauth.sys.cron.<job>. Settings you give override the built-in job of the same name, and other built-in jobs stay as they are.',
      ),
  })
  .prefault({})
  .describe('Scheduler: publishes cron ticks for the services that own each job.');

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

export const BUILTIN_SOCIAL_IDS = ['google', 'github', 'discord', 'steam'] as const;
export type BuiltinSocialId = (typeof BUILTIN_SOCIAL_IDS)[number];

const RESERVED_PROVIDER_IDS = new Set([
  ...BUILTIN_SOCIAL_IDS,
  'password',
  'magic_link',
  'passkey',
  'totp',
  'recovery',
  'oidc',
]);

const genericOidcProvider = z
  .strictObject({
    id: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]*$/, 'Must be lowercase letters, digits, - or _')
      .refine((id) => !RESERVED_PROVIDER_IDS.has(id), {
        message: 'Must not match a built-in provider or sign-in method',
      })
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
    safety: z
      .strictObject({
        reports: toggle(true, 'user, content and game report intake'),
        game_intake: toggle(true, 'the game and service report intake API'),
        automated_flags: toggle(true, 'automated flag intake from games and services'),
        moderation: toggle(true, 'the moderation queue, actions and two-person bans'),
        appeals: toggle(true, 'appeals against locks, bans and restrictions'),
        csea: toggle(true, 'the CSEA / NCA case workflow'),
      })
      .prefault({})
      .describe('Safety features (safety profile).'),
  })
  .prefault({})
  .describe('Feature flags inside services.');

export const CAPTCHA_PROVIDERS = [
  'altcha',
  'turnstile',
  'hcaptcha',
  'friendly_captcha',
  'none',
] as const;

export type CaptchaProviderName = (typeof CAPTCHA_PROVIDERS)[number];

const vendorCaptcha = (name: string) =>
  z
    .strictObject({
      site_key: z.string().default('').describe(`${name} site key, public in the widget.`),
      secret_key: z.string().default('').describe(`${name} secret key. Reference a secret.`),
    })
    .prefault({})
    .describe(`${name} settings.`);

export const captcha = z
  .strictObject({
    provider: z
      .enum(CAPTCHA_PROVIDERS)
      .default('altcha')
      .describe(
        'CAPTCHA provider. altcha is self-hosted proof-of-work. none disables CAPTCHA. The others verify with that vendor.',
      ),
    after: z
      .int()
      .min(0)
      .max(10_000)
      .default(3)
      .describe(
        'Show a CAPTCHA after this many failed password attempts from an IP, or this many signup or magic-link starts from an IP. 0 shows it on the first attempt.',
      ),
    window: duration('15m', 'Attempts older than this do not count towards the CAPTCHA threshold.'),
    altcha: z
      .strictObject({
        hmac_key: z
          .string()
          .default('')
          .describe(
            'HMAC key for Altcha challenges. Empty generates a key at startup; set it when running more than one identity replica.',
          ),
        max_number: z
          .int()
          .min(100)
          .max(10_000_000)
          .default(100_000)
          .describe('Altcha proof-of-work upper bound. Higher is harder for the client.'),
        expires: duration('2m', 'An Altcha challenge works for this long.'),
      })
      .prefault({})
      .describe('Altcha (self-hosted proof-of-work).'),
    turnstile: vendorCaptcha('Cloudflare Turnstile'),
    hcaptcha: vendorCaptcha('hCaptcha'),
    friendly_captcha: vendorCaptcha('Friendly Captcha'),
  })
  .superRefine((value, ctx) => {
    if (value.provider === 'none' || value.provider === 'altcha') return;
    const settings = value[value.provider];
    const path = value.provider;
    if (!settings.site_key) {
      ctx.addIssue({
        code: 'custom',
        message: 'Required when this provider is selected',
        path: [path, 'site_key'],
      });
    }
    if (!settings.secret_key) {
      ctx.addIssue({
        code: 'custom',
        message: 'Required when this provider is selected',
        path: [path, 'secret_key'],
      });
    }
  })
  .prefault({})
  .describe('Bot protection. Shown after captcha.after attempts from an IP, then required.');

export const EMAIL_PROVIDERS = ['smtp', 'console'] as const;

function isLocale(value: string): boolean {
  try {
    return Intl.getCanonicalLocales(value)[0] === value;
  } catch {
    return false;
  }
}

export const emailSection = z
  .strictObject({
    provider: z
      .enum(EMAIL_PROVIDERS)
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
    default_locale: z
      .string()
      .refine(isLocale, 'Must be a canonical locale like en-GB')
      .default('en-GB')
      .describe(
        "Locale used when an email's locale has no templates. Every template must exist in this locale.",
      ),
    templates_dir: z
      .string()
      .min(1)
      .default('templates/email')
      .describe(
        'Directory of template overrides, one subdirectory per locale, relative to the config directory. A file here replaces the built-in file of the same name.',
      ),
    smtp: z
      .strictObject({
        host: z.string().min(1).default('localhost').describe('SMTP server host.'),
        port: z.int().min(1).max(65_535).default(587).describe('SMTP server port.'),
        security: z
          .enum(['starttls', 'tls', 'none'])
          .default('starttls')
          .describe(
            'starttls upgrades the connection and refuses servers that cannot, tls connects over TLS (usually port 465), none never uses TLS.',
          ),
        user: z
          .string()
          .min(1)
          .nullable()
          .default(null)
          .describe('SMTP user. null sends without authenticating.'),
        password: z.string().default('').describe("The SMTP user's password. Reference a secret."),
        connect_timeout: duration('10s', 'Give up connecting after this long.'),
        send_timeout: duration(
          '30s',
          'Give up on a send when the server goes quiet for this long.',
        ),
      })
      .refine((smtp) => !smtp.password || smtp.user !== null, {
        message: 'Required when password is set',
        path: ['user'],
      })
      .prefault({})
      .describe('SMTP provider settings.'),
    queue: z
      .strictObject({
        max_attempts: z
          .int()
          .min(1)
          .default(20)
          .describe('Try sending an email this many times before marking it failed.'),
        retry_delay: duration('10s', 'Delay before the first retry. Doubles with each attempt.'),
        max_retry_delay: duration('30m', 'Longest delay between retries.'),
      })
      .refine((queue) => queue.max_retry_delay >= queue.retry_delay, {
        message: 'Must be at least retry_delay',
        path: ['max_retry_delay'],
      })
      .prefault({})
      .describe(
        'Outgoing email queue. With the defaults, an email is retried for about 6 hours before it fails.',
      ),
  })
  .prefault({})
  .describe('Outgoing email.');

export const WEBHOOK_FORMATS = ['standard', 'discord', 'slack'] as const;
export type WebhookFormat = (typeof WEBHOOK_FORMATS)[number];

export const WEBHOOK_EVENTS = [
  'safety.report.created',
  'safety.report.acknowledged',
  'safety.report.actioned',
  'safety.report.dismissed',
  'safety.report.sla_breached',
  'safety.flag.created',
  'safety.appeal.created',
  'identity.user.created',
  'identity.user.banned',
  'identity.user.deleted',
  'support.ticket.created',
  'support.ticket.status_changed',
  'games.entitlement.granted',
  'games.entitlement.revoked',
  'oidc.client.created',
] as const;
export type WebhookEventName = (typeof WEBHOOK_EVENTS)[number];

export const WEBHOOK_SUBSCRIPTION = /^(?:\*|[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*(?:\.\*)?)$/;
export const WEBHOOK_SUBSCRIPTION_MESSAGE =
  'Must be an event like identity.user.banned, a prefix like safety.report.*, or *';
export const WEBHOOK_DESCRIPTION_MAX = 200;
export const WEBHOOK_SLUG = ROLE_SLUG;
export const WEBHOOK_SLUG_MESSAGE = 'Must be a lowercase slug like discord_moderation';

export function webhookEventMatches(pattern: string, event: string): boolean {
  if (pattern === '*') return true;
  if (pattern === event) return true;
  return pattern.endsWith('.*') && event.startsWith(pattern.slice(0, -1));
}

export function isWebhookSubscription(pattern: string): boolean {
  if (!WEBHOOK_SUBSCRIPTION.test(pattern)) return false;
  return WEBHOOK_EVENTS.some((event) => webhookEventMatches(pattern, event));
}

function isWebhookUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      url.hostname !== '' &&
      url.username === '' &&
      url.password === ''
    );
  } catch {
    return false;
  }
}

const webhookEndpoint = z
  .strictObject({
    url: z
      .string()
      .refine(isWebhookUrl, 'Must be an http or https URL without userinfo')
      .describe('Destination URL. Discord and Slack incoming-webhook URLs can be pasted as-is.'),
    description: z
      .string()
      .trim()
      .min(1)
      .max(WEBHOOK_DESCRIPTION_MAX)
      .describe('What this endpoint is for.'),
    events: z
      .array(
        z
          .string()
          .refine(isWebhookSubscription, WEBHOOK_SUBSCRIPTION_MESSAGE)
          .describe('An event name, a prefix ending in .*, or *.'),
      )
      .min(1)
      .refine((events) => new Set(events).size === events.length, {
        message: 'Event subscriptions must be unique',
      })
      .describe('Events to send. Prefixes end in .* . CSEA events are never delivered, even to *.'),
    format: z
      .enum(WEBHOOK_FORMATS)
      .default('standard')
      .describe(
        'standard is the JSON envelope signed with Standard Webhooks. discord and slack format a readable message.',
      ),
    secret: z
      .string()
      .default('')
      .describe(
        'Standard Webhooks signing secret. Empty generates one on seed. Reference a secret.',
      ),
    enabled: z.boolean().default(true).describe('Whether this endpoint is sent events.'),
  })
  .describe('A seeded webhook endpoint.');

export const webhooks = z
  .strictObject({
    allow_private_targets: z
      .boolean()
      .default(false)
      .describe(
        'Allow URLs whose DNS resolves to private, loopback or link-local addresses. Off by default.',
      ),
    disable_after_failures: z
      .int()
      .min(1)
      .default(50)
      .describe(
        'Disable an endpoint after this many consecutive failed deliveries, and email admins.',
      ),
    timeout: duration('10s', 'Give up on a delivery when the target is quiet for this long.'),
    retry_window: duration(
      '24h',
      'Keep retrying a failed delivery for this long, then mark it failed.',
    ),
    retry_delay: duration('1m', 'Delay before the first retry. Doubles with each attempt.'),
    max_retry_delay: duration('1h', 'Longest delay between retries.'),
    secret_overlap: duration(
      '24h',
      'How long the previous signing secret stays valid after rotation.',
    ),
    endpoints: z
      .record(z.string().regex(WEBHOOK_SLUG, WEBHOOK_SLUG_MESSAGE), webhookEndpoint)
      .default({})
      .describe(
        'Endpoints to seed on startup, keyed by slug. Existing slugs are left as they are; manage them with webhooks.manage after that.',
      ),
  })
  .refine((value) => value.max_retry_delay >= value.retry_delay, {
    message: 'Must be at least retry_delay',
    path: ['max_retry_delay'],
  })
  .prefault({})
  .describe('Outbound webhooks.');

export const retention = z
  .strictObject({
    delivery_logs: duration(
      '30d',
      'Keep email, webhook and back-channel logout delivery log entries for this long.',
    ),
    sessions: duration(
      '30d',
      'Keep sessions and their bindings for this long after they expire or are revoked.',
    ),
    tokens: duration(
      '24h',
      'Keep magic-link and other emailed tokens for this long after they expire.',
    ),
    session_security_events: duration('90d', 'Keep session security event log rows for this long.'),
    filter_decisions: duration(
      '30d',
      'Keep text-filter decisions, including the raw input, for this long.',
    ),
    audit: duration('730d', 'Keep audit log rows for this long. Oldest rows are removed first.'),
    oauth: duration(
      '30d',
      'Keep expired or revoked OAuth authorization codes, access tokens and refresh tokens for this long.',
    ),
    safety_reports: duration(
      '730d',
      'Keep closed safety reports and their snapshots for this long. Open reports and reports under a legal hold are not swept.',
    ),
    closed_tickets: duration(
      '730d',
      'Keep closed support tickets, messages and notes for this long after closing. Open tickets are not swept.',
    ),
    csea_evidence: duration(
      '365d',
      'Keep encrypted CSEA evidence this long after the NCA report is sent, then destroy it with an audit record. SI 2026/268 regulation 8(1)(b): one year.',
    ),
    csea_nca_reference: duration(
      '1825d',
      'Keep the NCA unique report reference this long after submission. SI 2026/268 regulation 8(1)(a): five years (365 × 5 days).',
    ),
  })
  .prefault({})
  .describe('How long data is kept. retention.sweep deletes anything older.');

export const BACKUP_DESTINATIONS = ['directory', 'storage'] as const;
export type BackupDestination = (typeof BACKUP_DESTINATIONS)[number];

export const backups = z
  .strictObject({
    destination: z
      .enum(BACKUP_DESTINATIONS)
      .default('directory')
      .describe(
        'Where backups and the deletion ledger are written. directory is a mounted volume. storage is the S3 bucket. Restore replay is a later release.',
      ),
    directory: z
      .string()
      .min(1)
      .default('/var/lib/qtiauth/backups')
      .describe('Directory for backups and the deletion ledger when destination is directory.'),
    retention: duration(
      '35d',
      'How long backups are kept. The deletion ledger is kept this long plus 30 days.',
    ),
  })
  .prefault({})
  .describe('Encrypted backups and the deletion ledger destination.');

function isStorageEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.pathname === '/';
  } catch {
    return false;
  }
}

export const storage = z
  .strictObject({
    enabled: z
      .boolean()
      .default(false)
      .describe(
        'Use S3-compatible object storage (the bundled MinIO or any external S3/R2/B2). Required for data exports above export_email_max_bytes, ticket attachments and cloud saves.',
      ),
    endpoint: z
      .string()
      .default('')
      .describe(
        'S3 API base URL, such as http://minio:9000 or https://s3.amazonaws.com. Empty when storage is off.',
      ),
    region: z.string().min(1).default('us-east-1').describe('S3 region. MinIO accepts us-east-1.'),
    bucket: z
      .string()
      .min(1)
      .default('qtiauth')
      .describe('Bucket for exports, attachments, cloud saves and the deletion ledger.'),
    access_key: z
      .string()
      .default('')
      .describe('S3 access key. Empty when storage is off. Reference a secret.'),
    secret_key: z
      .string()
      .default('')
      .describe('S3 secret key. Empty when storage is off. Reference a secret.'),
    force_path_style: z
      .boolean()
      .default(true)
      .describe('Path-style URLs (bucket in the path). Required for MinIO. Set false for AWS S3.'),
    create_bucket: z
      .boolean()
      .default(true)
      .describe('Create the bucket on startup if it does not exist. Turn off for Amazon S3.'),
    tls: z
      .strictObject({
        ca_file: z
          .string()
          .min(1)
          .nullable()
          .default(null)
          .describe('CA certificate file for verifying the server. null uses the system CAs.'),
      })
      .prefault({})
      .describe('TLS to the S3 endpoint.'),
    presign_expires: duration(
      '15m',
      'How long a presigned upload or download URL works, other than data-export links which use accounts.export_ttl.',
    ),
  })
  .superRefine((value, ctx) => {
    if (!value.enabled) return;
    if (!isStorageEndpoint(value.endpoint)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Must be an origin like http://minio:9000',
        path: ['endpoint'],
      });
    }
    if (!value.access_key) {
      ctx.addIssue({
        code: 'custom',
        message: 'Required when storage is enabled',
        path: ['access_key'],
      });
    }
    if (!value.secret_key) {
      ctx.addIssue({
        code: 'custom',
        message: 'Required when storage is enabled',
        path: ['secret_key'],
      });
    }
  })
  .prefault({})
  .describe('S3-compatible object storage.');

export const sections = {
  branding,
  surfaces,
  cookies,
  cors,
  network,
  geoip,
  text_filter: textFilter,
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
  webhooks,
  security,
  roles,
  accounts,
  magic_link: magicLink,
  password,
  sessions,
  session_security: sessionSecurity,
  age,
  parental,
  usernames,
  legal,
  oidc,
  games,
  safety,
  support,
  rate_limits: rateLimits,
  scheduler,
  retention,
  storage,
  backups,
};

export type SectionName = keyof typeof sections;
