import { sections } from '@qtiauth/config';
import { describe, expect, it } from 'vitest';

import { auditPoolConfig, poolConfig } from './connect.ts';

describe('poolConfig', () => {
  it("connects as the schema's role with its schema on the search path", () => {
    const database = sections.database.parse({
      roles: { notify: { password: 'secret' } },
      pool: { idle_timeout: '1m' },
    });
    expect(poolConfig(database, 'notify')).toEqual({
      host: 'postgres',
      port: 5432,
      database: 'qtiauth',
      user: 'qtiauth_notify',
      password: 'secret',
      ssl: false,
      max: 10,
      idleTimeoutMillis: 60_000,
      connectionTimeoutMillis: 10_000,
      application_name: 'qtiauth-notify',
      options: '-c search_path=notify',
    });
  });

  it('connects the audit role to the identity schema', () => {
    const database = sections.database.parse({
      audit: { password: 'audit-secret' },
    });
    expect(auditPoolConfig(database)).toEqual({
      host: 'postgres',
      port: 5432,
      database: 'qtiauth',
      user: 'qtiauth_audit',
      password: 'audit-secret',
      ssl: false,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      application_name: 'qtiauth-audit',
      options: '-c search_path=identity',
    });
  });

  it('uses the identity role when the audit password is empty', () => {
    const database = sections.database.parse({
      roles: { identity: { password: 'identity-secret' } },
    });
    expect(auditPoolConfig(database)).toMatchObject({
      user: 'qtiauth_identity',
      password: 'identity-secret',
      application_name: 'qtiauth-audit',
      options: '-c search_path=identity',
    });
  });

  it('maps ssl modes', () => {
    const ssl = (mode: string) =>
      poolConfig(sections.database.parse({ ssl: mode }), 'identity').ssl;
    expect(ssl('disable')).toBe(false);
    expect(ssl('require')).toEqual({ rejectUnauthorized: false });
    expect(ssl('verify-full')).toEqual({ rejectUnauthorized: true });
  });
});
