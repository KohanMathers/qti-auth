import { describe, expect, it } from 'vitest';

import {
  ALGORITHM,
  amzDate,
  canonicalQuery,
  canonicalRequest,
  credentialScope,
  encodePath,
  sha256Hex,
  uriEncode,
} from './sign.ts';

describe('S3 signing helpers', () => {
  it('encodes path segments and query the way SigV4 expects', () => {
    expect(uriEncode('a b')).toBe('a%20b');
    expect(encodePath('/qtiauth/users/a b')).toBe('/qtiauth/users/a%20b');
    expect(canonicalQuery({ 'list-type': '2', prefix: 'users/x' })).toBe(
      'list-type=2&prefix=users%2Fx',
    );
  });

  it('builds a canonical request with sorted signed headers', () => {
    const { date, datetime } = amzDate(new Date('2026-09-18T12:00:00Z'));
    expect(date).toBe('20260918');
    expect(datetime).toBe('20260918T120000Z');
    expect(credentialScope(date, 'us-east-1')).toBe('20260918/us-east-1/s3/aws4_request');
    const { request, signedHeaders } = canonicalRequest({
      method: 'GET',
      path: '/qtiauth/exports/a.zip',
      query: {},
      headers: {
        host: 'minio:9000',
        'x-amz-content-sha256': sha256Hex(new Uint8Array()),
        'x-amz-date': datetime,
      },
      payloadHash: sha256Hex(new Uint8Array()),
    });
    expect(signedHeaders).toBe('host;x-amz-content-sha256;x-amz-date');
    expect(request.startsWith('GET\n/qtiauth/exports/a.zip\n')).toBe(true);
    expect(ALGORITHM).toBe('AWS4-HMAC-SHA256');
  });
});
