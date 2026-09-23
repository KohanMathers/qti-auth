import { readFileSync } from 'node:fs';

import type { QtiauthConfig } from '@qtiauth/config';
import { Agent, type Dispatcher, fetch as undiciFetch } from 'undici';

import {
  ALGORITHM,
  amzDate,
  canonicalQuery,
  canonicalRequest,
  credentialScope,
  encodePath,
  sha256Hex,
  signature,
  UNSIGNED,
} from './sign.ts';
import {
  type ObjectStore,
  type PresignGetOptions,
  type StoredObject,
  StorageError,
} from './store.ts';

export type StorageConfig = QtiauthConfig['storage'];

const EMPTY = new Uint8Array();

interface Located {
  href: string;
  path: string;
  host: string;
}

function locate(
  config: StorageConfig,
  key: string | undefined,
  query: Record<string, string>,
): Located {
  const endpoint = new URL(config.endpoint);
  const path =
    key === undefined
      ? `/${config.bucket}`
      : config.force_path_style
        ? `/${config.bucket}/${key}`
        : `/${key}`;
  const host = config.force_path_style ? endpoint.host : `${config.bucket}.${endpoint.host}`;
  const origin = config.force_path_style ? endpoint.origin : `${endpoint.protocol}//${host}`;
  const search = canonicalQuery(query);
  return {
    href: `${origin}${encodePath(path)}${search === '' ? '' : `?${search}`}`,
    path,
    host,
  };
}

function dispatcherOf(config: StorageConfig): Dispatcher | undefined {
  if (config.tls.ca_file === null) return undefined;
  return new Agent({ connect: { ca: readFileSync(config.tls.ca_file) } });
}

function locationXml(region: string): Uint8Array | undefined {
  if (region === 'us-east-1') return undefined;
  return new TextEncoder().encode(
    `<CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><LocationConstraint>${region}</LocationConstraint></CreateBucketConfiguration>`,
  );
}

function decodeXml(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function listedObjects(xml: string): StoredObject[] {
  const objects: StoredObject[] = [];
  for (const item of xml.matchAll(
    /<Contents>\s*<Key>([^<]*)<\/Key>[\s\S]*?<LastModified>([^<]*)<\/LastModified>[\s\S]*?<Size>([^<]*)<\/Size>/g,
  )) {
    objects.push({
      key: decodeXml(item[1] ?? ''),
      lastModified: new Date(item[2] ?? ''),
      size: Number(item[3] ?? 0),
    });
  }
  return objects;
}

export function createS3Store(
  config: StorageConfig,
  clock: () => Date = () => new Date(),
): ObjectStore {
  if (!config.enabled) throw new StorageError('Object storage is not enabled');
  const dispatcher = dispatcherOf(config);

  async function send(options: {
    method: string;
    key?: string;
    query?: Record<string, string>;
    body?: Uint8Array;
    headers?: Record<string, string>;
    payloadHash?: string;
    ok: readonly number[];
  }): Promise<globalThis.Response> {
    const now = clock();
    const { date, datetime } = amzDate(now);
    const body = options.body ?? EMPTY;
    const payloadHash = options.payloadHash ?? sha256Hex(body);
    const located = locate(config, options.key, options.query ?? {});
    const headers: Record<string, string> = {
      host: located.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': datetime,
      ...options.headers,
    };
    const canonical = canonicalRequest({
      method: options.method,
      path: located.path,
      query: options.query ?? {},
      headers,
      payloadHash,
    });
    const sig = signature({
      secretKey: config.secret_key,
      region: config.region,
      datetime,
      date,
      canonicalRequest: canonical.request,
    });
    headers['authorization'] =
      `${ALGORITHM} Credential=${config.access_key}/${credentialScope(date, config.region)}, SignedHeaders=${canonical.signedHeaders}, Signature=${sig}`;
    const response = await undiciFetch(located.href, {
      method: options.method,
      headers,
      ...(options.method === 'GET' || options.method === 'HEAD' ? {} : { body: Buffer.from(body) }),
      ...(dispatcher === undefined ? {} : { dispatcher }),
    });
    if (options.ok.includes(response.status)) return response;
    const text = await response.text();
    throw new StorageError(
      `S3 ${options.method} ${options.key ?? config.bucket} failed: ${String(response.status)} ${text.slice(0, 200)}`,
    );
  }

  async function listAll(prefix: string): Promise<StoredObject[]> {
    const objects: StoredObject[] = [];
    let token: string | undefined;
    for (;;) {
      const query: Record<string, string> = { 'list-type': '2', prefix };
      if (token !== undefined) query['continuation-token'] = token;
      const response = await send({ method: 'GET', query, ok: [200] });
      const xml = await response.text();
      objects.push(...listedObjects(xml));
      if (!xml.includes('<IsTruncated>true</IsTruncated>')) return objects;
      token = /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml)?.[1];
      if (token === undefined) return objects;
    }
  }

  function responseQuery(response?: PresignGetOptions): Record<string, string> {
    const query: Record<string, string> = {};
    if (response?.contentType !== undefined) query['response-content-type'] = response.contentType;
    if (response?.contentDisposition !== undefined) {
      query['response-content-disposition'] = response.contentDisposition;
    }
    return query;
  }

  function presign(
    method: string,
    key: string,
    expiresSeconds: number,
    headers: Record<string, string> = {},
    response: Record<string, string> = {},
  ): string {
    const now = clock();
    const { date, datetime } = amzDate(now);
    const located = locate(config, key, {});
    const query: Record<string, string> = {
      ...response,
      'X-Amz-Algorithm': ALGORITHM,
      'X-Amz-Credential': `${config.access_key}/${credentialScope(date, config.region)}`,
      'X-Amz-Date': datetime,
      'X-Amz-Expires': String(expiresSeconds),
      'X-Amz-SignedHeaders': Object.keys({ host: located.host, ...headers })
        .map((name) => name.toLowerCase())
        .sort()
        .join(';'),
    };
    const canonical = canonicalRequest({
      method,
      path: located.path,
      query,
      headers: { host: located.host, ...headers },
      payloadHash: UNSIGNED,
    });
    query['X-Amz-Signature'] = signature({
      secretKey: config.secret_key,
      region: config.region,
      datetime,
      date,
      canonicalRequest: canonical.request,
    });
    return locate(config, key, query).href;
  }

  return {
    async put(key, body, contentType) {
      await send({ method: 'PUT', key, body, headers: { 'content-type': contentType }, ok: [200] });
    },
    async get(key) {
      const response = await send({ method: 'GET', key, ok: [200, 404] });
      if (response.status === 404) return undefined;
      return new Uint8Array(await response.arrayBuffer());
    },
    async delete(key) {
      await send({ method: 'DELETE', key, ok: [204, 200, 404] });
    },
    async deletePrefix(prefix) {
      const objects = await listAll(prefix);
      for (const object of objects) {
        await send({ method: 'DELETE', key: object.key, ok: [204, 200, 404] });
      }
      return objects.length;
    },
    list: (prefix) => listAll(prefix),
    presignGet: (key, expiresSeconds, response) =>
      Promise.resolve(presign('GET', key, expiresSeconds, {}, responseQuery(response))),
    presignPut: (key, contentType, expiresSeconds) =>
      Promise.resolve(presign('PUT', key, expiresSeconds, { 'content-type': contentType })),
    async checkBucket() {
      await send({ method: 'HEAD', ok: [200] });
    },
    async ensureBucket() {
      const existing = await send({ method: 'HEAD', ok: [200, 404] });
      if (existing.status === 200) return;
      if (!config.create_bucket) throw new StorageError(`Bucket ${config.bucket} does not exist`);
      const body = locationXml(config.region);
      await send({
        method: 'PUT',
        ...(body === undefined ? {} : { body, headers: { 'content-type': 'application/xml' } }),
        ok: [200, 409],
      });
    },
    close: async () => {
      if (dispatcher !== undefined) await dispatcher.close();
    },
  };
}
