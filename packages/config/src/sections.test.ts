import { describe, expect, it } from 'vitest';

import {
  accounts,
  age,
  bus,
  captcha,
  cors,
  emailSection,
  features,
  gateway,
  magicLink,
  geoip,
  network,
  password,
  rateLimits,
  retention,
  roles,
  scheduler,
  security,
  sessionSecurity,
  surfaces,
  usernames,
  legal,
  oidc,
  parental,
  storage,
  backups,
  webhooks,
} from './sections.ts';

function messages(result: { error?: { issues: { path: PropertyKey[]; message: string }[] } }) {
  return (result.error?.issues ?? []).map((i) => `${i.path.join('.')}: ${i.message}`);
}

describe('surfaces', () => {
  it('accepts every layout from the spec', () => {
    const layouts = [
      {
        account: { hosts: ['me.example.com'], base_path: '/' },
        support: { hosts: ['me.example.com'], base_path: '/support' },
        api: { hosts: ['me.example.com'], base_path: '/api' },
      },
      {
        account: { hosts: ['account.example.co.uk'] },
        support: { hosts: ['support.example.com'] },
        api: { hosts: ['auth.example.co.uk'] },
      },
      { account: { ports: [8080] }, support: { ports: [8081] }, api: { ports: [8082] } },
    ];
    for (const layout of layouts) {
      expect(messages(surfaces.safeParse(layout))).toEqual([]);
    }
  });

  it('rejects two surfaces on the same host and base path', () => {
    const result = surfaces.safeParse({
      account: { hosts: ['me.example.com'] },
      support: { hosts: ['other.example.com'] },
      api: { hosts: ['me.example.com'] },
    });
    expect(messages(result)).toEqual([
      'api.base_path: Same host or port and base_path as surfaces.account',
    ]);
  });

  it('rejects bad base paths, ports and module names', () => {
    const result = surfaces.safeParse({
      account: { ports: [0], base_path: 'account' },
      support: { hosts: ['me.example.com'], base_path: '/support/', modules: ['billing'] },
      api: { hosts: [] },
    });
    expect(messages(result)).toEqual([
      'account.ports.0: Too small: expected number to be >=1',
      'account.base_path: Must start with "/" and not end with "/", e.g. / or /support',
      'support.base_path: Must start with "/" and not end with "/", e.g. / or /support',
      expect.stringMatching(/^support\.modules\.0: /),
      'api.hosts: Set at least one of hosts or ports',
    ]);
  });
});

describe('cors', () => {
  it('only accepts bare origins', () => {
    const result = cors.safeParse({
      allowed_origins: ['https://app.example.com', 'https://app.example.com/', 'app.example.com'],
    });
    expect(messages(result)).toEqual([
      'allowed_origins.1: Must be an origin like https://app.example.com',
      'allowed_origins.2: Must be an origin like https://app.example.com',
    ]);
  });
});

describe('network', () => {
  it('accepts IPs and CIDR ranges', () => {
    const valid = ['10.0.0.1', '10.0.0.0/8', '::1', 'fd00::/8'];
    expect(messages(network.safeParse({ trusted_proxies: valid }))).toEqual([]);
    const invalid = ['10.0.0.0/33', 'fd00::/129', 'proxy.local', '10.0.0.0/8/1'];
    expect(messages(network.safeParse({ trusted_proxies: invalid }))).toHaveLength(4);
  });
});

describe('features', () => {
  it('needs credentials only for enabled providers', () => {
    expect(
      messages(features.safeParse({ auth: { social: { google: { enabled: false } } } })),
    ).toEqual([]);
    expect(
      messages(features.safeParse({ auth: { social: { github: { enabled: true } } } })),
    ).toEqual([
      'auth.social.github.client_id: Required when enabled',
      'auth.social.github.client_secret: Required when enabled',
    ]);
  });

  it('requires unique generic OIDC provider ids', () => {
    const provider = {
      id: 'corp',
      name: 'Corp',
      issuer: 'https://id.example.com',
      client_id: 'id',
      client_secret: 'secret',
    };
    const result = features.safeParse({
      auth: { social: { generic_oidc: [provider, provider] } },
    });
    expect(messages(result)).toEqual(['auth.social.generic_oidc: Provider ids must be unique']);
  });

  it('refuses generic OIDC ids that collide with built-in providers', () => {
    const result = features.safeParse({
      auth: {
        social: {
          generic_oidc: [
            {
              id: 'google',
              name: 'Work Google',
              issuer: 'https://id.example.com',
              client_id: 'id',
              client_secret: 'secret',
            },
          ],
        },
      },
    });
    expect(messages(result)).toEqual([
      'auth.social.generic_oidc.0.id: Must not match a built-in provider or sign-in method',
    ]);
  });
});

describe('bus', () => {
  it('accepts NATS URLs only', () => {
    const result = bus.safeParse({
      servers: ['nats://nats:4222', 'tls://nats.internal:4222', 'http://nats:4222', 'nats'],
    });
    expect(messages(result)).toEqual([
      'servers.2: Must be a NATS URL like nats://nats:4222',
      'servers.3: Must be a NATS URL like nats://nats:4222',
    ]);
  });

  it('needs a user when a password is set', () => {
    expect(messages(bus.safeParse({ password: 'secret' }))).toEqual([
      'user: Required when password is set',
    ]);
    expect(messages(bus.safeParse({ user: 'qtiauth', password: 'secret' }))).toEqual([]);
  });

  it('remembers processed events for as long as the stream keeps them', () => {
    const result = bus.safeParse({
      streams: { events_max_age: '30d' },
      consumers: { retry_delay: '1m', max_retry_delay: '30s' },
    });
    expect(messages(result)).toEqual([
      'consumers.dedupe_retention: Must be at least streams.events_max_age, or redelivered events could run twice',
      'consumers.max_retry_delay: Must be at least retry_delay',
    ]);
  });
});

describe('gateway', () => {
  it('checks upstream names and discovery timings', () => {
    const result = gateway.safeParse({
      upstreams: { identity: 'http://identity:8080', Games: 'http://games:8080', oidc: 'oidc' },
      discovery: { interval: '1m', expiry: '30s' },
    });
    expect(messages(result)).toEqual([
      expect.stringMatching(/^upstreams\.Games: /),
      expect.stringMatching(/^upstreams\.oidc: /),
      'discovery.expiry: Must be longer than interval',
    ]);
  });
});

describe('rate_limits', () => {
  it('keeps the built-in policies and lets config replace them', () => {
    const policies = rateLimits.parse({ global: { per: 'ip', limit: 50, window: '10s' } });
    expect(policies['global']).toEqual({
      per: ['ip'],
      limit: 50,
      window: 10_000,
      on_store_failure: 'open',
    });
    expect(policies['auth_password']).toMatchObject({
      per: ['ip', 'account'],
      on_store_failure: 'closed',
    });
  });

  it('checks groups and the global policy', () => {
    const result = rateLimits.safeParse({
      global: { policies: ['magic_link_ip'] },
      signup: { policies: ['magic_link', 'missing'] },
      broken: { per: 'device', limit: 0 },
    });
    expect(messages(result)).toEqual([expect.stringMatching(/^broken: /)]);
    const groups = rateLimits.safeParse({
      global: { policies: ['magic_link_ip'] },
      signup: { policies: ['magic_link', 'missing'] },
    });
    expect(messages(groups)).toEqual([
      'global: global must be a single policy. It applies to every request',
      'signup.policies.0: Must name a single policy, not a group',
      'signup.policies.1: Must name a single policy, not an unknown one',
    ]);
  });
});

describe('scheduler', () => {
  it('keeps the built-in jobs and lets config change them', () => {
    const { jobs } = scheduler.parse({
      jobs: {
        'keys.rotate': { enabled: false },
        'retention.sweep': { schedule: '0 1 * * *' },
        'reports.digest': { schedule: '*/30 * * * * *' },
      },
    });
    expect(jobs['keys.rotate']).toEqual({ schedule: '0 0 * * *', enabled: false });
    expect(jobs['retention.sweep']).toEqual({ schedule: '0 1 * * *', enabled: true });
    expect(jobs['reports.digest']).toEqual({ schedule: '*/30 * * * * *', enabled: true });
    expect(jobs['accounts.unlock_expired']).toEqual({ schedule: '* * * * *', enabled: true });
    expect(jobs['webhooks.retry']).toEqual({ schedule: '* * * * *', enabled: true });
    expect(jobs['oidc.logout.retry']).toEqual({ schedule: '* * * * *', enabled: true });
  });

  it('checks job names, patterns and the time zone', () => {
    const result = scheduler.safeParse({
      timezone: 'Mars/Olympus_Mons',
      jobs: {
        'retention.sweep': { schedule: '0 3 * *' },
        'hourly.check': { schedule: '61 * * * *' },
      },
    });
    expect(messages(result)).toEqual([
      'timezone: Must be an IANA time zone like UTC or Europe/London',
      'jobs.retention.sweep.schedule: Must be a cron pattern like 0 3 * * *',
      'jobs.hourly.check.schedule: Must be a cron pattern like 0 3 * * *',
    ]);
    expect(messages(scheduler.safeParse({ jobs: { 'Retention.Sweep': {} } }))).toEqual([
      expect.stringMatching(/^jobs\.Retention\.Sweep: /),
    ]);
  });

  it('needs a schedule for jobs that are not built in', () => {
    expect(messages(scheduler.safeParse({ jobs: { 'reports.digest': {} } }))).toEqual([
      'jobs.reports.digest.schedule: Required for a job that is not built in',
    ]);
  });
});

describe('email', () => {
  it('checks the locale, SMTP credentials and retry delays', () => {
    const result = emailSection.safeParse({
      provider: 'brevo',
      default_locale: 'en_gb',
      smtp: { password: 'secret' },
      queue: { retry_delay: '1m', max_retry_delay: '30s' },
    });
    expect(messages(result)).toEqual([
      expect.stringMatching(/^provider: /),
      'default_locale: Must be a canonical locale like en-GB',
      'smtp.user: Required when password is set',
      'queue.max_retry_delay: Must be at least retry_delay',
    ]);
  });

  it('defaults to STARTTLS on port 587 and retries for hours', () => {
    const email = emailSection.parse({});
    expect(email.smtp).toMatchObject({ host: 'localhost', port: 587, security: 'starttls' });
    expect(email.queue).toEqual({
      max_attempts: 20,
      retry_delay: 10_000,
      max_retry_delay: 1_800_000,
    });
  });
});

describe('webhooks', () => {
  it('retries for a day and refuses private targets by default', () => {
    expect(webhooks.parse({})).toEqual({
      allow_private_targets: false,
      disable_after_failures: 50,
      timeout: 10_000,
      retry_window: 86_400_000,
      retry_delay: 60_000,
      max_retry_delay: 3_600_000,
      secret_overlap: 86_400_000,
      endpoints: {},
    });
  });

  it('seeds endpoints keyed by slug and checks subscriptions and URLs', () => {
    const parsed = webhooks.parse({
      endpoints: {
        discord: {
          url: 'https://discord.com/api/webhooks/1/token',
          description: 'Moderation',
          events: ['safety.report.*', 'identity.user.banned'],
          format: 'discord',
        },
      },
    });
    expect(parsed.endpoints['discord']).toMatchObject({
      format: 'discord',
      enabled: true,
      secret: '',
      events: ['safety.report.*', 'identity.user.banned'],
    });
    expect(
      messages(
        webhooks.safeParse({
          max_retry_delay: '30s',
          retry_delay: '1m',
          endpoints: {
            discord_alerts: {
              url: 'ftp://example.com/hook',
              description: '',
              events: ['safety.csea.*', 'not an event'],
            },
          },
        }),
      ),
    ).toEqual([
      'endpoints.discord_alerts.url: Must be an http or https URL without userinfo',
      'endpoints.discord_alerts.description: Too small: expected string to have >=1 characters',
      'endpoints.discord_alerts.events.0: Must be an event like identity.user.banned, a prefix like safety.report.*, or *',
      'endpoints.discord_alerts.events.1: Must be an event like identity.user.banned, a prefix like safety.report.*, or *',
      'max_retry_delay: Must be at least retry_delay',
    ]);
    expect(
      messages(
        webhooks.safeParse({
          endpoints: {
            'Discord.Alerts': {
              url: 'https://example.com/hook',
              description: 'Alerts',
              events: ['identity.user.banned'],
            },
          },
        }),
      ),
    ).toEqual([expect.stringMatching(/^endpoints\.Discord\.Alerts: /)]);
  });
});

describe('accounts', () => {
  it('allows two accounts per address and ignores Gmail dots and subaddresses by default', () => {
    const parsed = accounts.parse({});
    expect(parsed.max_per_email).toBe(2);
    expect(parsed.email_change_ttl).toBe(900_000);
    expect(parsed.email_revert_ttl).toBe(7 * 86_400_000);
    expect(parsed.email_normalization['googlemail.com']).toEqual({
      remove_dots: true,
      subaddress_separator: '+',
      domain: 'gmail.com',
    });
    expect(parsed.deletion_grace).toBe(30 * 24 * 60 * 60 * 1000);
    expect(parsed.export_ttl).toBe(7 * 24 * 60 * 60 * 1000);
    expect(parsed.export_email_max_bytes).toBe(524_288);
  });

  it('replaces the built-in rules and checks them', () => {
    expect(
      accounts.parse({ email_normalization: { 'example.com': { subaddress_separator: '-' } } })
        .email_normalization,
    ).toEqual({ 'example.com': { remove_dots: false, subaddress_separator: '-', domain: null } });
    const result = accounts.safeParse({
      max_per_email: 0,
      email_normalization: {
        'example.com': { subaddress_separator: '++', domain: 'not a domain' },
      },
    });
    expect(messages(result)).toEqual([
      'max_per_email: Too small: expected number to be >=1',
      expect.stringMatching(/^email_normalization\.example\.com\.subaddress_separator: /),
      'email_normalization.example.com.domain: Must be a domain',
    ]);
  });
});

describe('magic_link', () => {
  it('expires links after 15 minutes and signups after 30', () => {
    expect(magicLink.parse({})).toEqual({ ttl: 900_000, signup_ttl: 1_800_000 });
  });
});

describe('security', () => {
  it('requires two-factor for admin, safety and support permissions by default', () => {
    const parsed = security.parse({});
    expect(parsed.step_up_window).toBe(600_000);
    expect(parsed.encryption_key).toBe('');
    expect(parsed.require_2fa_for_permissions).toEqual([
      'users.*',
      'safety.*',
      'support.*',
      'games.*',
      'oidc.clients.*',
      'webhooks.manage',
      'audit.read',
      'roles.manage',
      'filter.*',
    ]);
  });

  it('rejects a permission that is not dotted lowercase words', () => {
    expect(messages(security.safeParse({ require_2fa_for_permissions: ['Users'] }))).toEqual([
      'require_2fa_for_permissions.0: Must be a permission, a prefix like users.*, or *',
    ]);
  });
});

describe('roles', () => {
  it('ships admin, moderator, support, knowledge-base and game-manager roles', () => {
    const parsed = roles.parse(undefined);
    expect(Object.keys(parsed)).toEqual([
      'admin',
      'moderator',
      'support_agent',
      'kb_editor',
      'game_manager',
    ]);
    expect(parsed['admin']).toEqual({
      name: 'Admin',
      description: 'Full access, except permissions that must be granted by name.',
      permissions: ['*'],
    });
  });

  it('requires an admin role and unique well-formed grants', () => {
    expect(messages(roles.safeParse({}))).toEqual([': Must include an admin role']);
    expect(
      messages(
        roles.safeParse({
          admin: { name: 'Admin', description: 'All of it', permissions: ['*', '*'] },
        }),
      ),
    ).toEqual(['admin.permissions: Permissions must be unique']);
    expect(
      messages(
        roles.safeParse({
          'Support Agent': { name: 'Support', description: 'Tickets', permissions: [] },
          admin: { name: 'Admin', description: 'All of it', permissions: ['Users'] },
        }),
      ),
    ).toEqual([
      expect.stringMatching(/^Support Agent: /),
      'admin.permissions.0: Must be a permission, a prefix like users.*, or *',
    ]);
  });
});

describe('password', () => {
  it('uses OWASP Argon2id defaults and optional composition rules', () => {
    expect(password.parse({})).toEqual({
      min_length: 10,
      max_length: 256,
      composition: {
        require_lower: false,
        require_upper: false,
        require_digit: false,
        require_symbol: false,
      },
      breach_check: true,
      argon2: { memory_kib: 19_456, iterations: 2, parallelism: 1 },
      reset_ttl: 900_000,
      verification_ttl: 900_000,
      failure_delay: { step: 250, max: 2_000 },
    });
  });

  it('caps length at 256 and keeps min_length and Argon2 memory in range', () => {
    expect(messages(password.safeParse({ min_length: 20, max_length: 12 }))).toEqual([
      'min_length: Must be less than or equal to max_length',
    ]);
    expect(messages(password.safeParse({ max_length: 257 }))).toEqual([
      'max_length: Too big: expected number to be <=256',
    ]);
    expect(messages(password.safeParse({ argon2: { memory_kib: 8, parallelism: 2 } }))).toEqual([
      'argon2.memory_kib: Must be at least 8 KiB per parallel lane',
    ]);
    expect(messages(password.safeParse({ failure_delay: { step: '3s', max: '1s' } }))).toEqual([
      'failure_delay.step: Must be less than or equal to max',
    ]);
  });
});

describe('captcha', () => {
  it('defaults to Altcha after three attempts', () => {
    expect(captcha.parse({})).toMatchObject({
      provider: 'altcha',
      after: 3,
      window: 900_000,
      altcha: { hmac_key: '', max_number: 100_000, expires: 120_000 },
    });
  });

  it('needs vendor keys only for that provider', () => {
    expect(messages(captcha.safeParse({ provider: 'none' }))).toEqual([]);
    expect(messages(captcha.safeParse({ provider: 'altcha' }))).toEqual([]);
    expect(messages(captcha.safeParse({ provider: 'turnstile' }))).toEqual([
      'turnstile.site_key: Required when this provider is selected',
      'turnstile.secret_key: Required when this provider is selected',
    ]);
    expect(
      messages(
        captcha.safeParse({
          provider: 'hcaptcha',
          hcaptcha: { site_key: 'site', secret_key: 'secret' },
        }),
      ),
    ).toEqual([]);
  });
});

describe('age', () => {
  it('starts the bands at 13, 16 and 18, and keeps them in order', () => {
    expect(age.parse({}).bands).toEqual({ '13_to_15': 13, '16_to_17': 16, adult: 18 });
    expect(messages(age.safeParse({ bands: { '16_to_17': 19 } }))).toEqual([
      'bands: Each band must start at a greater age than the one before',
    ]);
  });

  it('ships self_declared assurance with no required triggers', () => {
    expect(age.parse({}).assurance).toEqual({
      default_provider: 'self_declared',
      required_for: [],
    });
    expect(age.parse({ assurance: { required_for: ['claim_adult_band'] } }).assurance).toEqual({
      default_provider: 'self_declared',
      required_for: ['claim_adult_band'],
    });
    expect(
      messages(
        age.safeParse({ assurance: { required_for: ['claim_adult_band', 'claim_adult_band'] } }),
      ),
    ).toEqual(['assurance.required_for: Triggers must be unique']);
    expect(messages(age.safeParse({ assurance: { default_provider: 'yoti' } }))).toEqual([
      'assurance.default_provider: Invalid input: expected "self_declared"',
    ]);
  });
});

describe('usernames', () => {
  it('uses 8–18 letters, digits and underscores, with empty reserved lists', () => {
    expect(usernames.parse({})).toEqual({
      min_length: 8,
      max_length: 18,
      charset: '[A-Za-z0-9_]',
      reserved: [],
      reserved_prefixes: [],
      change_cooldown: 2_592_000_000,
      changes_per_year: 3,
      change_window: 31_536_000_000,
      release_hold: 7_776_000_000,
    });
  });

  it('rejects a max shorter than min, and a charset that is not a character class', () => {
    expect(messages(usernames.safeParse({ min_length: 10, max_length: 8 }))).toEqual([
      'max_length: Must be at least min_length',
    ]);
    expect(messages(usernames.safeParse({ charset: 'A-Za-z0-9_' }))).toEqual([
      'charset: Must be a character class like [A-Za-z0-9_]',
    ]);
  });
});

describe('parental', () => {
  it('needs consent under 13 and deletes unapproved accounts after 14 days', () => {
    expect(parental.parse({})).toEqual({
      consent_age: 13,
      pending_ttl: 1_209_600_000,
      max_guardians: 2,
      graduation_grace: 2_592_000_000,
    });
  });
});

describe('legal', () => {
  it('publishes version history and reads documents from legal/ by default', () => {
    expect(legal.parse({})).toEqual({ public_history: true, documents_dir: 'legal' });
  });
});

describe('retention', () => {
  it('keeps delivery logs and sessions for 30 days and tokens for a day by default', () => {
    expect(retention.parse({})).toEqual({
      delivery_logs: 2_592_000_000,
      sessions: 2_592_000_000,
      tokens: 86_400_000,
      session_security_events: 7_776_000_000,
      filter_decisions: 2_592_000_000,
      audit: 63_072_000_000,
      oauth: 2_592_000_000,
    });
  });
});

describe('oidc', () => {
  it('ships built-in scopes and ES256 keys that last 90 days', () => {
    const parsed = oidc.parse({});
    expect(parsed.signing.algorithm).toBe('ES256');
    expect(parsed.signing.rotate_after).toBe(7_776_000_000);
    expect(parsed.access_ttl).toBe(900_000);
    expect(parsed.device_code_ttl).toBe(900_000);
    expect(parsed.device_interval).toBe(5_000);
    expect(parsed.pushed_authorization_ttl).toBe(60_000);
    expect(parsed.logout).toEqual({
      timeout: 10_000,
      retry_window: 86_400_000,
      retry_delay: 60_000,
      max_retry_delay: 3_600_000,
      allow_private_targets: false,
    });
    expect(parsed.scopes['openid']).toEqual({ consent: 'Sign you in', claims: [] });
    expect(parsed.scopes['email']?.claims).toEqual(['email', 'email_verified']);
    expect(parsed.clients).toEqual({});
  });

  it('needs a secret for confidential clients and known scopes', () => {
    expect(
      messages(
        oidc.safeParse({
          clients: {
            app: {
              name: 'App',
              type: 'confidential',
              redirect_uris: ['https://app.example.com/callback'],
            },
          },
        }),
      ),
    ).toEqual(['clients.app.secret: Required for confidential clients']);
    expect(
      messages(
        oidc.safeParse({
          clients: {
            app: {
              name: 'App',
              type: 'public',
              redirect_uris: ['https://app.example.com/callback'],
              allowed_scopes: ['not_a_scope'],
            },
          },
        }),
      ),
    ).toEqual(['clients.app.allowed_scopes.0: Must name a configured scope']);
    expect(
      messages(
        oidc.safeParse({
          clients: {
            app: {
              name: 'App',
              type: 'public',
              redirect_uris: ['http://[::1]/callback'],
            },
          },
        }),
      ),
    ).toEqual([]);
    expect(
      messages(
        oidc.safeParse({
          clients: {
            app: {
              name: 'App',
              type: 'public',
              backchannel_logout_uri: 'http://example.com/logout',
            },
          },
        }),
      ),
    ).toEqual([
      'clients.app.backchannel_logout_uri: Must be an https URL, or http on 127.0.0.1 or [::1]',
    ]);
    expect(
      messages(
        oidc.safeParse({
          clients: {
            app: {
              name: 'App',
              type: 'public',
              backchannel_logout_uri: 'http://127.0.0.1/backchannel',
            },
          },
        }),
      ),
    ).toEqual([]);
    expect(
      messages(oidc.safeParse({ logout: { retry_delay: '1h', max_retry_delay: '1m' } })),
    ).toEqual(['logout.max_retry_delay: Must be at least retry_delay']);
    expect(
      oidc.parse({
        clients: {
          server: { name: 'Server', type: 'confidential', secret: 's' },
        },
      }).clients['server'],
    ).toMatchObject({
      redirect_uris: [],
      require_par: false,
      backchannel_logout_uri: null,
      backchannel_logout_session_required: false,
    });
  });

  it('keeps replaced keys published at least as long as live tokens', () => {
    expect(
      messages(oidc.safeParse({ access_ttl: '2h', signing: { retain_after_rotation: '1h' } })),
    ).toEqual([
      'signing.retain_after_rotation: Must be at least access_ttl, so replaced keys can still verify live tokens',
    ]);
  });
});

describe('storage', () => {
  it('is off by default and needs an endpoint and keys when enabled', () => {
    expect(storage.parse({})).toMatchObject({
      enabled: false,
      endpoint: '',
      region: 'us-east-1',
      bucket: 'qtiauth',
      force_path_style: true,
      create_bucket: true,
      presign_expires: 900_000,
    });
    expect(messages(storage.safeParse({ enabled: true }))).toEqual([
      'endpoint: Must be an origin like http://minio:9000',
      'access_key: Required when storage is enabled',
      'secret_key: Required when storage is enabled',
    ]);
    expect(
      messages(
        storage.safeParse({
          enabled: true,
          endpoint: 'http://minio:9000',
          access_key: 'key',
          secret_key: 'secret',
        }),
      ),
    ).toEqual([]);
  });
});

describe('backups', () => {
  it('writes to a directory for 35 days by default', () => {
    expect(backups.parse({})).toEqual({
      destination: 'directory',
      directory: '/var/lib/qtiauth/backups',
      retention: 35 * 24 * 60 * 60 * 1000,
    });
  });
});

describe('geoip', () => {
  it('needs a header when the source is a header', () => {
    expect(messages(geoip.safeParse({ source: 'header' }))).toEqual([
      'header: Required when source is header',
    ]);
    expect(messages(geoip.safeParse({ source: 'header', header: 'x-country' }))).toEqual([]);
  });
});

describe('sessionSecurity', () => {
  it('challenges on a country change and emails new devices by default', () => {
    expect(sessionSecurity.parse({})).toEqual({
      on_country_change: 'challenge',
      new_device_email: true,
      tls_fingerprint: { header: null },
      alert_min_interval: 3_600_000,
    });
  });
});
