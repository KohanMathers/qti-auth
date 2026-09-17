import { describe, expect, it } from 'vitest';

import { bus, cors, features, gateway, network, rateLimits, surfaces } from './sections.ts';

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
