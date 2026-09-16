import { describe, expect, it } from 'vitest';

import { cors, features, network, surfaces } from './sections.ts';

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
