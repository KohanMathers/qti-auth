import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

import { describe, expect, it } from 'vitest';

import { JSON_SCHEMA_PATH, renderJsonSchema } from '../scripts/write-json-schema.ts';
import { loadConfig } from './load.ts';
import { qtiauthConfigSchema } from './schema.ts';

const root = join(import.meta.dirname, '../../..');

describe('shipped config', () => {
  it('config/qtiauth.yaml is valid with .env.example', async () => {
    const env = parseEnv(readFileSync(join(root, '.env.example'), 'utf8'));
    const config = await loadConfig(qtiauthConfigSchema, {
      path: join(root, 'config/qtiauth.yaml'),
      env,
    });
    expect(config.branding.company_name).toBe('Example Ltd');
  });

  it('config/qtiauth.yaml sets nothing the defaults would not, apart from trusted proxies for the shipped Docker stack', async () => {
    const env = parseEnv(readFileSync(join(root, '.env.example'), 'utf8'));
    const shipped = await loadConfig(qtiauthConfigSchema, {
      path: join(root, 'config/qtiauth.yaml'),
      env,
    });
    const defaults = qtiauthConfigSchema.parse({});
    expect({ ...shipped, surfaces: defaults.surfaces, network: defaults.network }).toEqual(
      defaults,
    );
    expect(shipped.network.trusted_proxies).toEqual([
      '10.0.0.0/8',
      '172.16.0.0/12',
      '192.168.0.0/16',
    ]);
  });

  it('config/qtiauth.dev.yaml only switches email to the console provider and adds local origins', async () => {
    const env = parseEnv(readFileSync(join(root, '.env.example'), 'utf8'));
    const dev = await loadConfig(qtiauthConfigSchema, {
      path: join(root, 'config/qtiauth.dev.yaml'),
      env,
    });
    const defaults = qtiauthConfigSchema.parse({});
    const origins = ['http://localhost:8000'];
    expect(dev).toEqual({
      ...defaults,
      surfaces: {
        account: { ...defaults.surfaces.account, origins },
        support: { ...defaults.surfaces.support, origins },
        api: { ...defaults.surfaces.api, origins },
      },
      email: { ...defaults.email, provider: 'console' },
    });
  });

  it('config/qtiauth.dev.yaml references the same secrets as config/qtiauth.yaml', () => {
    const references = (path: string) =>
      [
        ...readFileSync(join(root, path), 'utf8')
          .replace(/^#.*$/gm, '')
          .matchAll(/\$\{env:(\w+)\}/g),
      ]
        .map((match) => match[1])
        .sort();
    expect(references('config/qtiauth.dev.yaml')).toEqual(references('config/qtiauth.yaml'));
  });

  it('config/qtiauth.schema.json is up to date (run pnpm config:schema)', () => {
    expect(readFileSync(JSON_SCHEMA_PATH, 'utf8')).toBe(renderJsonSchema());
  });
});
