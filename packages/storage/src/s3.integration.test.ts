import { sections } from '@qtiauth/config';
import { startMinio } from '@qtiauth/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { eraseUserObjects } from './client.ts';
import { exportObjectKey, heldObjectKey, userObjectKey } from './keys.ts';
import { createS3Store } from './s3.ts';

const USER_ID = '0199a0e0-0000-7000-8000-000000000001';

let minio: Awaited<ReturnType<typeof startMinio>>;

beforeAll(async () => {
  minio = await startMinio();
});

afterAll(async () => {
  await minio.stop();
});

describe('S3 object store', () => {
  it('puts, presigns, lists and erases objects including held ones when asked', async () => {
    const store = createS3Store(
      sections.storage.parse({
        enabled: true,
        endpoint: minio.endpoint,
        bucket: minio.bucket,
        access_key: minio.accessKey,
        secret_key: minio.secretKey,
        force_path_style: true,
        create_bucket: true,
      }),
    );
    await store.ensureBucket();
    const body = new TextEncoder().encode('export-bytes');
    const key = exportObjectKey(USER_ID, 'job-1');
    await store.put(key, body, 'application/zip');
    await store.put(
      userObjectKey(USER_ID, 'note.txt'),
      new TextEncoder().encode('hi'),
      'text/plain',
    );
    await store.put(
      heldObjectKey(USER_ID, 'case.json'),
      new TextEncoder().encode('{"held":true}'),
      'application/json',
    );

    expect(new TextDecoder().decode((await store.get(key)) ?? new Uint8Array())).toBe(
      'export-bytes',
    );
    const download = await store.presignGet(key, 60);
    const fetched = await fetch(download);
    expect(fetched.status).toBe(200);
    expect(await fetched.text()).toBe('export-bytes');

    const uploadKey = userObjectKey(USER_ID, 'upload.bin');
    const upload = await store.presignPut(uploadKey, 'application/octet-stream', 60);
    const put = await fetch(upload, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array([1, 2, 3]),
    });
    expect(put.status).toBe(200);
    expect([...((await store.get(uploadKey)) ?? new Uint8Array())]).toEqual([1, 2, 3]);

    expect(await eraseUserObjects(store, USER_ID, { preserveHeld: true })).toBeGreaterThanOrEqual(
      3,
    );
    expect(await store.get(key)).toBeUndefined();
    expect(await store.get(heldObjectKey(USER_ID, 'case.json'))).toBeDefined();
    await store.close();
  });
});
