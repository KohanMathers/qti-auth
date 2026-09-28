import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

interface ClientModule {
  apiClient: (
    bootstrap: { basePath: string; metaOrigin: string | null },
    fetcher?: Fetcher,
  ) => {
    get: (path: string) => Promise<unknown>;
    post: (path: string, body?: unknown) => Promise<unknown>;
    delete: (path: string) => Promise<unknown>;
  };
  auth: (client: unknown) => Record<string, unknown>;
  ProblemFetchError: new (problem: unknown) => Error;
}

const mod = (await import(
  pathToFileURL(new URL('./assets/client.js', import.meta.url).pathname).toString()
)) as ClientModule;

function jsonResponse(status: number, body: unknown, contentType = 'application/json'): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': contentType },
  });
}

describe('apiClient', () => {
  it('sends requests through the meta origin when the account surface is cross-site', async () => {
    const calls: string[] = [];
    const client = mod.apiClient(
      { basePath: '/', metaOrigin: 'https://api.example.test' },
      (url) => {
        calls.push(url);
        return Promise.resolve(jsonResponse(200, { ok: true }));
      },
    );
    await client.get('/me');
    expect(calls).toEqual(['https://api.example.test/api/v1/me']);
  });

  it('uses the base path when the account surface serves its own API', async () => {
    const calls: string[] = [];
    const client = mod.apiClient({ basePath: '/', metaOrigin: null }, (url) => {
      calls.push(url);
      return Promise.resolve(jsonResponse(200, {}));
    });
    await client.get('/me');
    expect(calls[0]).toBe('/api/v1/me');
  });

  it('throws a ProblemFetchError with the parsed body on a Problem response', async () => {
    const client = mod.apiClient({ basePath: '/', metaOrigin: null }, () =>
      Promise.resolve(
        jsonResponse(
          400,
          { code: 'VALIDATION_FAILED', title: 'Bad', status: 400 },
          'application/problem+json',
        ),
      ),
    );
    await expect(client.get('/me')).rejects.toBeInstanceOf(mod.ProblemFetchError);
  });

  it('returns null on a 204 response', async () => {
    const client = mod.apiClient({ basePath: '/', metaOrigin: null }, () =>
      Promise.resolve(new Response(null, { status: 204 })),
    );
    await expect(client.delete('/sessions/abc')).resolves.toBeNull();
  });

  it('sends a JSON body when one is provided', async () => {
    let seen: RequestInit | undefined;
    const client = mod.apiClient({ basePath: '/', metaOrigin: null }, (_url, init) => {
      seen = init;
      return Promise.resolve(jsonResponse(200, {}));
    });
    await client.post('/auth/password/login', { email: 'a@b.test', password: 'x' });
    expect(seen?.headers).toEqual({ 'content-type': 'application/json' });
    expect(seen?.body).toBe(JSON.stringify({ email: 'a@b.test', password: 'x' }));
  });
});

describe('auth helpers', () => {
  it('exposes the roadmap sign-in methods', () => {
    const captured: string[] = [];
    const client = {
      post: (path: string) => {
        captured.push(path);
        return Promise.resolve({});
      },
      get: () => Promise.resolve({}),
      put: () => Promise.resolve({}),
      patch: () => Promise.resolve({}),
      delete: () => Promise.resolve({}),
    };
    const a = mod.auth(client) as {
      signInPassword: (email: string, password: string) => Promise<unknown>;
      magicLinkStart: (email: string) => Promise<unknown>;
      forgot: (email: string) => Promise<unknown>;
      reset: (token: string, password: string) => Promise<unknown>;
    };
    void a.signInPassword('a@b.test', 'x');
    void a.magicLinkStart('a@b.test');
    void a.forgot('a@b.test');
    void a.reset('t', 'x');
    expect(captured).toEqual([
      '/auth/password/login',
      '/auth/magic-link/start',
      '/auth/password/forgot',
      '/auth/password/reset',
    ]);
  });
});
