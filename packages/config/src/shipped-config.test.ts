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

  it('config/qtiauth.yaml sets nothing the defaults would not', async () => {
    const env = parseEnv(readFileSync(join(root, '.env.example'), 'utf8'));
    const shipped = await loadConfig(qtiauthConfigSchema, {
      path: join(root, 'config/qtiauth.yaml'),
      env,
    });
    const defaults = qtiauthConfigSchema.parse({});
    expect({ ...shipped, surfaces: defaults.surfaces }).toEqual(defaults);
  });

  it('config/qtiauth.schema.json is up to date (run pnpm config:schema)', () => {
    expect(readFileSync(JSON_SCHEMA_PATH, 'utf8')).toBe(renderJsonSchema());
  });
});
