import { openApiDocument } from '@qtiauth/service-kit';
import { describe, expect, it } from 'vitest';

import { definition, router } from './service.ts';

describe('notifier service', () => {
  it('announces itself without any routes', () => {
    expect(router.manifest()).toMatchObject({ service: 'notifier', routes: [] });
    expect(openApiDocument(router)).toMatchObject({ paths: {} });
  });

  it('ships migrations for the notify schema, starting with the bus tables', async () => {
    expect(definition.database.schema).toBe('notify');
    const migrations = await definition.database.migrations();
    expect(migrations.map((migration) => migration.name)).toEqual([
      '0001_bus_tables',
      '0002_email_deliveries',
    ]);
  });
});
