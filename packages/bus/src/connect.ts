import { type JetStreamClient, type JetStreamManager, jetstreamManager } from '@nats-io/jetstream';
import { connect, type NatsConnection, type NodeConnectionOptions } from '@nats-io/transport-node';
import type { QtiauthConfig } from '@qtiauth/config';

export type BusConfig = QtiauthConfig['bus'];

export interface Bus {
  service: string;
  config: BusConfig;
  nc: NatsConnection;
  js: JetStreamClient;
  jsm: JetStreamManager;
  close: () => Promise<void>;
}

export function natsOptions(config: BusConfig, service: string): NodeConnectionOptions {
  const { tls } = config;
  return {
    servers: config.servers,
    name: `qtiauth-${service}`,
    timeout: config.connect_timeout,
    maxReconnectAttempts: -1,
    ...(config.user === null ? {} : { user: config.user, pass: config.password }),
    ...(tls.required || tls.ca_file !== null
      ? { tls: tls.ca_file === null ? {} : { caFile: tls.ca_file } }
      : {}),
  };
}

export async function connectBus(config: BusConfig, service: string): Promise<Bus> {
  const nc = await connect(natsOptions(config, service));
  try {
    const jsm = await jetstreamManager(nc);
    return {
      service,
      config,
      nc,
      js: jsm.jetstream(),
      jsm,
      close: () => nc.drain(),
    };
  } catch (error) {
    await nc.close();
    throw error;
  }
}
