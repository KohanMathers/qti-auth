export type ConsumeOutcome = 'processed' | 'duplicate' | 'failed' | 'rejected';
export type RpcOutcome = 'ok' | 'error' | 'timeout' | 'no_responders';

export interface BusMetrics {
  published: (subject: string) => void;
  publishFailed: (subject: string) => void;
  consumed: (consumer: string, subject: string, outcome: ConsumeOutcome) => void;
  redelivered: (consumer: string, subject: string) => void;
  consumerLag: (consumer: string, pending: number) => void;
  outboxBacklog: (service: string, size: number, oldestAgeSeconds: number) => void;
  rpcRequest: (subject: string, outcome: RpcOutcome, seconds: number) => void;
}

const ignore = (): void => undefined;

export const noopBusMetrics: BusMetrics = {
  published: ignore,
  publishFailed: ignore,
  consumed: ignore,
  redelivered: ignore,
  consumerLag: ignore,
  outboxBacklog: ignore,
  rpcRequest: ignore,
};
