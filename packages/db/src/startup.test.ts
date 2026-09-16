import { describe, expect, it } from 'vitest';

import { PendingMigrationsError } from './startup.ts';

describe('PendingMigrationsError', () => {
  it('names the pending migrations and the exact command to apply them', () => {
    const error = new PendingMigrationsError('notifier', 'notify', ['0001_a', '0002_b']);
    expect(error.command).toBe('docker compose run --rm notifier qtiauth migrate up');
    expect(error.message).toBe(
      'Schema notify has 2 pending migration(s) and migrations.auto_apply is false: 0001_a, 0002_b\n' +
        'Apply them with:\n' +
        '  docker compose run --rm notifier qtiauth migrate up',
    );
  });
});
