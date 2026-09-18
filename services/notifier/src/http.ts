import { Agent, fetch as undiciFetch } from 'undici';

import {
  type DnsLookup,
  isBlockedAddress,
  resolveWebhookHost,
  WebhookTargetError,
} from './ssrf.ts';

export interface WebhookHttpResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface WebhookPost {
  url: string;
  headers: Record<string, string>;
  body: string;
  timeout: number;
  allowPrivate: boolean;
}

export type WebhookHttp = (request: WebhookPost) => Promise<WebhookHttpResult>;

function headerMap(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

export function createWebhookHttp(options: { lookup?: DnsLookup | undefined } = {}): WebhookHttp {
  return async (request) => {
    const url = new URL(request.url);
    const agent = new Agent({
      connect: {
        lookup: (hostname, lookupOptions, callback) => {
          void resolveWebhookHost(hostname, options.lookup).then(
            (addresses) => {
              if (!request.allowPrivate) {
                const blocked = addresses.find((entry) => isBlockedAddress(entry.address));
                if (blocked !== undefined) {
                  callback(
                    new WebhookTargetError(
                      `Refusing to send to ${hostname}: ${blocked.address} is a private, loopback or link-local address`,
                    ),
                    '',
                    4,
                  );
                  return;
                }
              }
              const chosen = addresses[0];
              if (chosen === undefined) {
                callback(new WebhookTargetError(`Could not resolve ${hostname}`), '', 4);
                return;
              }
              if (lookupOptions.all === true) {
                (
                  callback as unknown as (
                    err: NodeJS.ErrnoException | null,
                    addresses: { address: string; family: number }[],
                  ) => void
                )(null, addresses);
                return;
              }
              callback(null, chosen.address, chosen.family);
            },
            (error: unknown) => {
              callback(error as NodeJS.ErrnoException, '', 4);
            },
          );
        },
      },
    });
    try {
      const response = await undiciFetch(url, {
        method: 'POST',
        headers: { ...request.headers, 'content-type': 'application/json' },
        body: request.body,
        dispatcher: agent,
        signal: AbortSignal.timeout(request.timeout),
        redirect: 'manual',
      });
      return {
        status: response.status,
        headers: headerMap(response.headers),
        body: await response.text(),
      };
    } finally {
      await agent.close();
    }
  };
}
