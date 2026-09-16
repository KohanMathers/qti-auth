import { isIP } from 'node:net';

import * as z from 'zod';

import { duration } from './duration.ts';

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
  features,
  captcha,
  email: emailSection,
};

export type SectionName = keyof typeof sections;
