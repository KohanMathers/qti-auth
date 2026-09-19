import { sections } from '@qtiauth/config';
import { describe, expect, it } from 'vitest';

import type { RunningService } from './discovery.ts';
import { enabledFeatures, featuresReport, healthReport, type MetaConfig } from './meta.ts';
import { resolveSurfaces } from './surfaces.ts';

function running(...names: string[]): RunningService[] {
  return names.map((name) => ({
    name,
    version: '1.0.0',
    instances: 1,
    manifest: { service: name, version: '1.0.0', routes: [], permissions: [], notifications: [] },
  }));
}

function config(features: unknown = {}): MetaConfig {
  return {
    branding: sections.branding.parse({}),
    features: sections.features.parse(features),
    geoip: sections.geoip.parse({ source: 'header', header: 'cf-ipcountry' }),
    storage: sections.storage.parse({
      enabled: true,
      endpoint: 'http://minio:9000',
      access_key: 'k',
      secret_key: 's',
    }),
  };
}

const minimal = {
  oidc: { developer_portal: { enabled: false }, backchannel_logout: { enabled: false } },
  games: {
    licensing: { enabled: false },
    leaderboards: { enabled: false },
    playtime: { enabled: false },
    keys: { enabled: false },
  },
  support: {
    tickets: { enabled: false },
    kb: { enabled: false },
    guest_tickets: { enabled: false },
  },
};

describe('enabledFeatures', () => {
  it('lists every enabled sub-feature with the service it needs', () => {
    const features = enabledFeatures(sections.features.parse({}));
    expect(features).toContainEqual({
      feature: 'features.games.licensing.enabled',
      service: 'games',
    });
    expect(features).toContainEqual({
      feature: 'features.oidc.developer_portal.enabled',
      service: 'oidc',
    });
    expect(features).toContainEqual({
      feature: 'features.oidc.backchannel_logout.enabled',
      service: 'oidc',
    });
    expect(features).not.toContainEqual(
      expect.objectContaining({ feature: 'features.games.steam.enabled' }),
    );
    expect(enabledFeatures(sections.features.parse(minimal))).toEqual([]);
  });
});

describe('healthReport', () => {
  it('is ok when every needed service is running', () => {
    expect(
      healthReport({
        config: config(minimal),
        services: running('gateway', 'identity', 'notifier', 'scheduler'),
        routeProblems: [],
        starting: false,
      }),
    ).toEqual({
      status: 'ok',
      services: [
        { name: 'identity', instances: 1 },
        { name: 'notifier', instances: 1 },
        { name: 'scheduler', instances: 1 },
      ],
      problems: [],
    });
  });

  it('reports enabled features whose service is not running', () => {
    const report = healthReport({
      config: config({ ...minimal, games: { ...minimal.games, licensing: { enabled: true } } }),
      services: running('identity', 'notifier', 'scheduler'),
      routeProblems: [],
      starting: false,
    });
    expect(report.status).toBe('degraded');
    expect(report.problems).toEqual([
      {
        code: 'FEATURE_SERVICE_NOT_RUNNING',
        feature: 'features.games.licensing.enabled',
        service: 'games',
      },
    ]);
  });

  it('says starting instead of degraded during the startup grace', () => {
    const report = healthReport({
      config: config(minimal),
      services: [],
      routeProblems: [],
      starting: true,
    });
    expect(report.status).toBe('starting');
    expect(report.problems.map((problem) => problem.code)).toEqual([
      'SERVICE_NOT_RUNNING',
      'SERVICE_NOT_RUNNING',
      'SERVICE_NOT_RUNNING',
    ]);
  });
});

describe('featuresReport', () => {
  const surfaces = resolveSurfaces({
    surfaces: sections.surfaces.parse({
      account: { hosts: ['account.example.com'] },
      support: { hosts: ['support.example.com'] },
      api: { hosts: ['api.example.net'] },
    }),
  });

  it('reports what exists, never secrets', () => {
    const report = featuresReport({
      config: config({
        auth: {
          social: {
            google: { enabled: true, client_id: 'id', client_secret: 'super-secret' },
            generic_oidc: [
              {
                id: 'corp',
                name: 'Corp',
                issuer: 'https://id.example.com',
                client_id: 'corp-id',
                client_secret: 'corp-secret',
              },
            ],
          },
        },
      }),
      surfaces,
      isRunning: (service) => ['identity', 'games'].includes(service),
    });
    expect(JSON.stringify(report)).not.toMatch(/secret|corp-id/);
    expect(report.modules).toEqual({
      identity: true,
      admin: true,
      oidc: false,
      games: true,
      safety: false,
      support: false,
    });
    expect(report.auth.social).toEqual([
      { id: 'google', name: 'Google', icon: null },
      { id: 'corp', name: 'Corp', icon: null },
    ]);
    expect(report.auth.session_security).toBe(true);
    expect(report.features['games']?.['licensing']).toBe(true);
    expect(report.features['support']?.['tickets']).toBe(false);
    expect(report.surface_pairs).toEqual([
      { surfaces: ['account', 'support'], same_site: true },
      { surfaces: ['account', 'api'], same_site: false },
      { surfaces: ['support', 'api'], same_site: false },
    ]);
  });

  it('turns auth methods off while identity is not running', () => {
    const report = featuresReport({ config: config(), surfaces, isRunning: () => false });
    expect(report.auth.methods).toEqual({
      password: false,
      magic_link: false,
      passkeys: false,
      totp: false,
    });
    expect(report.auth.social).toEqual([]);
  });

  it('lists cross-site pairs on health without marking the stack degraded', () => {
    const report = healthReport({
      config: config(minimal),
      services: running('identity', 'notifier', 'scheduler'),
      routeProblems: [],
      starting: false,
      surfaces,
    });
    expect(report.status).toBe('ok');
    expect(report.problems).toEqual([
      { code: 'CROSS_SITE_SURFACES', surfaces: ['account', 'api'] },
      { code: 'CROSS_SITE_SURFACES', surfaces: ['support', 'api'] },
    ]);
  });

  it('warns when GeoIP is unavailable without degrading the stack', () => {
    const report = healthReport({
      config: {
        ...config(minimal),
        geoip: sections.geoip.parse({ source: 'none' }),
      },
      services: running('identity', 'notifier', 'scheduler'),
      routeProblems: [],
      starting: false,
      geoip: { available: false, attribution: null },
    });
    expect(report.status).toBe('ok');
    expect(report.problems).toEqual([{ code: 'GEOIP_UNAVAILABLE', source: 'none' }]);
  });

  it('warns when object storage is off without degrading the stack', () => {
    const report = healthReport({
      config: { ...config(minimal), storage: sections.storage.parse({}) },
      services: running('identity', 'notifier', 'scheduler'),
      routeProblems: [],
      starting: false,
    });
    expect(report.status).toBe('ok');
    expect(report.problems).toEqual([{ code: 'STORAGE_UNAVAILABLE' }]);
  });
});
