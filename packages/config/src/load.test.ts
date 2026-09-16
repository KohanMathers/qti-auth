import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as z from 'zod';

import { ConfigError } from './errors.ts';
import { CONFIG_PATH_ENV, loadConfig, parseConfig, resolveConfigPath } from './load.ts';
import { qtiauthConfigSchema, serviceConfigSchema } from './schema.ts';

const parseOptions = { source: 'test.yaml', env: {}, baseDir: '/' };

async function issuesFor(text: string, env: Record<string, string> = {}) {
  const error: unknown = await parseConfig(qtiauthConfigSchema, text, {
    ...parseOptions,
    env,
  }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ConfigError);
  return (error as ConfigError).issues;
}

describe('parseConfig', () => {
  it('fills every default for an empty file', async () => {
    const config = await parseConfig(qtiauthConfigSchema, '', parseOptions);
    expect(config.branding.product_name).toBe('Example Account');
    expect(config.cookies.session_ttl).toBe(7 * 24 * 60 * 60 * 1000);
    expect(config.surfaces.support).toEqual({
      hosts: ['localhost'],
      ports: [],
      base_path: '/support',
      modules: null,
    });
  });

  it('names the exact YAML path and line of an invalid value', async () => {
    const issues = await issuesFor(
      ['surfaces:', '  api:', '    hosts: [me.example.com, "bad host"]'].join('\n'),
    );
    expect(issues).toEqual([
      {
        path: ['surfaces', 'api', 'hosts', 1],
        message: 'Must be a hostname, without scheme or port',
        line: 3,
        column: 29,
      },
    ]);
  });

  it('reports unknown settings by their own path', async () => {
    const issues = await issuesFor('cookies:\n  sesion_ttl: 7d\ntypo: true\n');
    expect(issues.map((i) => [i.path.join('.'), i.message, i.line])).toEqual([
      ['cookies.sesion_ttl', 'Unknown setting', 2],
      ['typo', 'Unknown setting', 3],
    ]);
  });

  it('reports interpolation and schema issues together, in file order', async () => {
    const issues = await issuesFor(
      [
        'branding:',
        '  support_email: not-an-email',
        'features:',
        '  auth:',
        '    social:',
        '      google:',
        '        enabled: true',
        '        client_id: ${env:GOOGLE_CLIENT_ID}',
        '        client_secret: ${env:GOOGLE_CLIENT_SECRET}',
      ].join('\n'),
      { GOOGLE_CLIENT_SECRET: 'secret' },
    );
    expect(issues.map((i) => `${i.path.join('.')}: ${i.message}`)).toEqual([
      'branding.support_email: Must be an email address',
      'features.auth.social.google.client_id: Environment variable GOOGLE_CLIENT_ID is not set',
      'features.auth.social.google.client_id: Required when enabled',
    ]);
  });

  it('reports the first YAML syntax error with its position', async () => {
    const issues = await issuesFor('a: [1\nb: 2\n');
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ path: [], line: 2, column: 1 });
  });

  it('rejects duplicate keys', async () => {
    const issues = await issuesFor('migrations:\n  auto_apply: true\n  auto_apply: false\n');
    expect(issues[0]?.message).toMatch(/unique/i);
  });

  it('rejects a document that is not a mapping', async () => {
    const issues = await issuesFor('- a\n- b\n');
    expect(issues[0]?.message).toBe('Config must be a mapping of settings');
  });

  it('formats every issue into the error message', async () => {
    const error = await parseConfig(qtiauthConfigSchema, 'geoip:\n  source: header\n', {
      ...parseOptions,
    }).catch((e: unknown) => e);
    expect((error as Error).message).toBe(
      'Invalid config in test.yaml:\n  geoip.header (line 2, column 3): Required when source is header',
    );
  });
});

describe('serviceConfigSchema', () => {
  it('validates only the chosen sections and ignores the rest', async () => {
    const schema = serviceConfigSchema(['cookies']);
    const config = await parseConfig(schema, 'cookies: { idle_timeout: 1h }\nother: {}\n', {
      ...parseOptions,
    });
    expect(config).toEqual({
      cookies: { domain: null, session_ttl: 604_800_000, idle_timeout: 3_600_000 },
    });
  });

  it('still rejects unknown keys inside a chosen section', async () => {
    const schema = serviceConfigSchema(['cookies']);
    await expect(parseConfig(schema, 'cookies: { nope: 1 }', parseOptions)).rejects.toThrow(
      'cookies.nope (line 1, column 18): Unknown setting',
    );
  });
});

describe('loadConfig', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'qtiauth-config-'));
    await writeFile(join(dir, 'secret.txt'), 'from-file\n');
    await writeFile(
      join(dir, 'qtiauth.yaml'),
      'branding:\n  product_name: ${file:secret.txt}\n  company_name: ${env:COMPANY}\n',
    );
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads the file and resolves file references relative to it', async () => {
    const schema = z.object({ branding: qtiauthConfigSchema.shape.branding });
    const config = await loadConfig(schema, {
      path: join(dir, 'qtiauth.yaml'),
      env: { COMPANY: 'Acme' },
    });
    expect(config.branding).toMatchObject({ product_name: 'from-file', company_name: 'Acme' });
  });

  it('uses the path from the environment', async () => {
    const config = await loadConfig(serviceConfigSchema(['branding']), {
      env: { [CONFIG_PATH_ENV]: join(dir, 'qtiauth.yaml'), COMPANY: 'Env' },
    });
    expect(config.branding.company_name).toBe('Env');
  });

  it('throws ConfigError for a missing file', async () => {
    await expect(
      loadConfig(qtiauthConfigSchema, { path: join(dir, 'missing.yaml'), env: {} }),
    ).rejects.toThrow("(root): Can't read config file (ENOENT)");
  });
});

describe('resolveConfigPath', () => {
  it('defaults to config/qtiauth.yaml', () => {
    expect(resolveConfigPath({})).toBe('config/qtiauth.yaml');
    expect(resolveConfigPath({ [CONFIG_PATH_ENV]: '' })).toBe('config/qtiauth.yaml');
  });
});
