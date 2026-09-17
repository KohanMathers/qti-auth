import type { CliIo } from '@qtiauth/cli';
import { describe, expect, it } from 'vitest';

import { runServiceCli, serviceCommands } from './cli.ts';
import { defineService } from './service.ts';
import { createRouter } from './routes.ts';

const definition = defineService({
  name: 'support',
  version: '2.0.0',
  module: 'support',
  database: { schema: 'support', migrations: () => Promise.resolve([]) },
});

const router = createRouter({ service: 'support', version: '2.0.0', module: 'support' });
router.route({
  method: 'GET',
  path: '/api/v1/support/ping',
  operation_id: 'ping',
  summary: 'Ping',
  auth: 'none',
  rate_limit: 'global',
  responses: { 204: { description: 'Pong' } },
  handler: () => Promise.resolve({ status: 204 as const }),
});

function capture() {
  const out = { stdout: '', stderr: '' };
  const io: CliIo = {
    stdout: (text) => (out.stdout += text),
    stderr: (text) => (out.stderr += text),
    env: {},
  };
  return { io, out };
}

describe('service CLI', () => {
  it('includes the shared commands, migrations for the service schema and route commands', () => {
    expect(Object.keys(serviceCommands(definition, router)).sort()).toEqual([
      'config check',
      'db provision',
      'lists audit',
      'lists update',
      'migrate status',
      'migrate up',
      'routes manifest',
      'routes openapi',
    ]);
    const withoutDatabase = defineService({ name: 'scheduler', version: '1', module: 'core' });
    expect(Object.keys(serviceCommands(withoutDatabase, router))).not.toContain('migrate up');
  });

  it('prints the manifest and OpenAPI document', async () => {
    const manifest = capture();
    await runServiceCli(definition, router, {}, ['routes', 'manifest'], manifest.io);
    expect(process.exitCode).toBe(0);
    expect(JSON.parse(manifest.out.stdout)).toMatchObject({
      service: 'support',
      routes: [{ method: 'GET', path: '/api/v1/support/ping', auth: 'none' }],
    });

    const openapi = capture();
    await runServiceCli(definition, router, {}, ['routes', 'openapi'], openapi.io);
    expect(JSON.parse(openapi.out.stdout)).toMatchObject({
      openapi: '3.1.1',
      paths: { '/api/v1/support/ping': { get: { operationId: 'ping' } } },
    });

    const extra = capture();
    await runServiceCli(definition, router, {}, ['routes', 'openapi', 'nope'], extra.io);
    expect(process.exitCode).toBe(2);
    expect(extra.out.stderr).toContain('Usage: qtiauth routes openapi');
    process.exitCode = 0;
  });

  it('adds service-specific commands', async () => {
    const { io, out } = capture();
    await runServiceCli(
      definition,
      router,
      {
        'audit verify': (_args, commandIo) => {
          commandIo.stdout('chain ok\n');
          return Promise.resolve(0);
        },
      },
      ['audit', 'verify'],
      io,
    );
    expect(out.stdout).toBe('chain ok\n');
  });
});

describe('defineService', () => {
  it('rejects names that are not valid bus subject tokens', () => {
    expect(() =>
      defineService({ name: 'Support-Service', version: '1', module: 'support' }),
    ).toThrow('lowercase letters');
    expect(() => defineService({ name: 'support', version: ' ', module: 'support' })).toThrow(
      'needs a version',
    );
  });
});
