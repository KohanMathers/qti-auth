import { createHash, createHmac } from 'node:crypto';

export const UNSIGNED = 'UNSIGNED-PAYLOAD';
export const ALGORITHM = 'AWS4-HMAC-SHA256';

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function hmac(key: Uint8Array | string, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

export function uriEncode(value: string, encodeSlash = true): string {
  let encoded = encodeURIComponent(value).replaceAll(/[!'()*]/g, (char) => {
    return `%${char.charCodeAt(0).toString(16).toUpperCase()}`;
  });
  if (!encodeSlash) encoded = encoded.replaceAll('%2F', '/');
  return encoded;
}

export function encodePath(path: string): string {
  return path
    .split('/')
    .map((segment) => uriEncode(segment))
    .join('/');
}

export function amzDate(now: Date): { date: string; datetime: string } {
  const datetime = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { date: datetime.slice(0, 8), datetime };
}

export function credentialScope(date: string, region: string): string {
  return `${date}/${region}/s3/aws4_request`;
}

export function signingKey(secretKey: string, date: string, region: string): Buffer {
  const dateKey = hmac(`AWS4${secretKey}`, date);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, 's3');
  return hmac(serviceKey, 'aws4_request');
}

export function canonicalQuery(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((key) => `${uriEncode(key)}=${uriEncode(params[key] ?? '')}`)
    .join('&');
}

export function canonicalHeaders(headers: Record<string, string>): {
  canonical: string;
  signed: string;
} {
  const names = Object.keys(headers)
    .map((name) => name.toLowerCase())
    .sort();
  const lower: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    lower[name.toLowerCase()] = value.trim().replaceAll(/\s+/g, ' ');
  }
  return {
    canonical: names.map((name) => `${name}:${lower[name] ?? ''}`).join('\n') + '\n',
    signed: names.join(';'),
  };
}

export function canonicalRequest(options: {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  payloadHash: string;
}): { request: string; signedHeaders: string } {
  const { canonical, signed } = canonicalHeaders(options.headers);
  return {
    request: [
      options.method,
      encodePath(options.path),
      canonicalQuery(options.query),
      canonical,
      signed,
      options.payloadHash,
    ].join('\n'),
    signedHeaders: signed,
  };
}

export function signature(options: {
  secretKey: string;
  region: string;
  datetime: string;
  date: string;
  canonicalRequest: string;
}): string {
  const stringToSign = [
    ALGORITHM,
    options.datetime,
    credentialScope(options.date, options.region),
    sha256Hex(options.canonicalRequest),
  ].join('\n');
  return hmac(signingKey(options.secretKey, options.date, options.region), stringToSign).toString(
    'hex',
  );
}
