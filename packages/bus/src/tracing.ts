import { headers, type MsgHdrs } from '@nats-io/transport-node';
import type { Attributes, Context } from '@opentelemetry/api';
import { extractTraceContext, injectTraceContext } from '@qtiauth/observability';

export type MessagingOperation = 'send' | 'process';

export function traceHeaders(): MsgHdrs {
  const hdrs = headers();
  injectTraceContext((name, value) => {
    hdrs.set(name, value);
  });
  return hdrs;
}

export function messageTraceContext(hdrs: MsgHdrs | undefined): Context {
  return extractTraceContext((name) => (hdrs?.has(name) ? hdrs.get(name) : undefined));
}

export function messagingAttributes(operation: MessagingOperation, subject: string): Attributes {
  return {
    'messaging.system': 'nats',
    'messaging.operation.type': operation,
    'messaging.destination.name': subject,
  };
}
