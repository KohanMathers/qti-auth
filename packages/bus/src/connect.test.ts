import { sections } from '@qtiauth/config';
import { describe, expect, it } from 'vitest';

import { natsOptions } from './connect.ts';

describe('natsOptions', () => {
  it('connects without credentials or forced TLS by default', () => {
    expect(natsOptions(sections.bus.parse({}), 'identity')).toEqual({
      servers: ['nats://nats:4222'],
      name: 'qtiauth-identity',
      timeout: 10_000,
      maxReconnectAttempts: -1,
    });
  });

  it('passes credentials and TLS settings', () => {
    const bus = sections.bus.parse({
      user: 'qtiauth',
      password: 'secret',
      tls: { ca_file: '/run/secrets/nats-ca.pem' },
    });
    expect(natsOptions(bus, 'games')).toMatchObject({
      user: 'qtiauth',
      pass: 'secret',
      tls: { caFile: '/run/secrets/nats-ca.pem' },
    });
    expect(natsOptions(sections.bus.parse({ tls: { required: true } }), 'games').tls).toEqual({});
  });
});
