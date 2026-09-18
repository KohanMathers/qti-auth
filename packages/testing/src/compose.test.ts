import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { IMAGES } from './images.ts';

const root = join(import.meta.dirname, '../../..');

interface ComposeService {
  image?: string;
  profiles?: string[];
  ports?: string[];
  networks?: string[];
  network_mode?: string;
  healthcheck?: { test: string[] };
  environment?: Record<string, string>;
  depends_on?: Record<string, { condition: string }>;
}

interface ComposeFile {
  services: Record<string, ComposeService>;
  networks?: Record<string, { internal?: boolean }>;
}

function readText(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

function readCompose(path: string): ComposeFile {
  return parse(readText(path), { merge: true }) as ComposeFile;
}

const base = readCompose('deploy/compose.yaml');
const dev = readCompose('deploy/compose.dev.yaml');

const INFRA = ['postgres', 'valkey', 'nats'] as const;

const PROFILES: Record<string, string[]> = {
  oidc: ['oidc'],
  safety: ['safety'],
  support: ['support'],
  games: ['games'],
  storage: ['minio'],
  geoip: ['geoip-updater'],
  edge: ['caddy'],
  backup: ['backup'],
  observability: ['prometheus', 'grafana', 'tempo', 'loki'],
};

const QTIAUTH_SERVICES = [
  'gateway',
  'identity',
  'notifier',
  'scheduler',
  'oidc',
  'safety',
  'support',
  'games',
];

const PUBLIC_SERVICES: Record<string, string[]> = { gateway: ['8000:8000'] };

function servicesByProfile(compose: ComposeFile): Record<string, string[]> {
  const byProfile: Record<string, string[]> = {};
  for (const [name, service] of Object.entries(compose.services)) {
    for (const profile of service.profiles ?? []) {
      (byProfile[profile] ??= []).push(name);
    }
  }
  return byProfile;
}

describe('deploy/compose.yaml', () => {
  it('runs the same infra images as the integration tests', () => {
    for (const name of INFRA) {
      expect(base.services[name]?.image, name).toBe(IMAGES[name]);
    }
    expect(base.services['minio']?.image).toBe(IMAGES.minio);
  });

  it('runs infra without a profile, with a healthcheck, on the internal network', () => {
    for (const name of INFRA) {
      const service = base.services[name];
      expect(service?.profiles, name).toBeUndefined();
      expect(service?.healthcheck?.test, name).toBeDefined();
      expect(service?.networks, name).toEqual(['internal']);
    }
    expect(base.networks?.['internal']?.internal).toBe(true);
  });

  it('has a service for every profile in SPEC §2.2', () => {
    expect(servicesByProfile(base)).toEqual(PROFILES);
  });

  it('starts QTIAuth services after healthy infra, with the config mounted', () => {
    for (const name of QTIAUTH_SERVICES) {
      expect(base.services[name]?.depends_on, name).toEqual(
        Object.fromEntries(INFRA.map((dep) => [dep, { condition: 'service_healthy' }])),
      );
      expect(base.services[name]?.networks, name).toEqual(
        name in PUBLIC_SERVICES ? ['internal', 'public'] : ['internal'],
      );
    }
  });

  it('publishes ports only for the gateway', () => {
    for (const [name, service] of Object.entries(base.services)) {
      expect(service.ports, name).toEqual(PUBLIC_SERVICES[name]);
    }
  });
});

describe('deploy/compose.dev.yaml', () => {
  it('only overrides services in the base file', () => {
    expect(Object.keys(base.services)).toEqual(expect.arrayContaining(Object.keys(dev.services)));
  });

  it('publishes debug ports on localhost only', () => {
    const ports = Object.values(dev.services).flatMap((service) => service.ports ?? []);
    expect(ports.length).toBeGreaterThan(0);
    for (const port of ports) {
      expect(port).toMatch(/^127\.0\.0\.1:\d+:\d+$/);
    }
  });

  it('points every QTIAuth service at the development config', () => {
    for (const name of QTIAUTH_SERVICES) {
      expect(dev.services[name]?.environment, name).toEqual({
        QTIAUTH_CONFIG: 'config/qtiauth.dev.yaml',
      });
    }
  });
});

describe('.env.example', () => {
  it('documents every variable the compose files use', () => {
    const documented = Object.keys(parseEnv(readText('.env.example')));
    const used = ['deploy/compose.yaml', 'deploy/compose.dev.yaml'].flatMap((path) =>
      [...readText(path).matchAll(/\$\{([A-Z0-9_]+)/g)].map((match) => match[1]),
    );
    expect(used.length).toBeGreaterThan(0);
    expect(documented).toEqual(expect.arrayContaining(used));
  });
});
