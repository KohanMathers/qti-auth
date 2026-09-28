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
  support: (client: unknown) => Record<string, unknown>;
  kb: (client: unknown) => Record<string, unknown>;
  guestSupport: (client: unknown) => Record<string, unknown>;
  staffSupport: (client: unknown) => Record<string, unknown>;
  staffKb: (client: unknown) => Record<string, unknown>;
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

describe('support helpers', () => {
  it('routes signed-in ticket calls through /support', () => {
    const gets: string[] = [];
    const posts: string[] = [];
    const client = {
      get: (path: string) => {
        gets.push(path);
        return Promise.resolve({});
      },
      post: (path: string) => {
        posts.push(path);
        return Promise.resolve({});
      },
      put: () => Promise.resolve({}),
      patch: () => Promise.resolve({}),
      delete: () => Promise.resolve({}),
    };
    const s = mod.support(client) as {
      listTickets: () => Promise<unknown>;
      getTicket: (id: string) => Promise<unknown>;
      createTicket: (spec: unknown) => Promise<unknown>;
      createAppeal: (spec: unknown) => Promise<unknown>;
    };
    void s.listTickets();
    void s.getTicket('abc');
    void s.createTicket({});
    void s.createAppeal({});
    expect(gets).toEqual(['/support/tickets', '/support/tickets/abc']);
    expect(posts).toEqual(['/support/tickets', '/support/appeals']);
  });

  it('routes guest ticket calls through /support/guest', () => {
    const posts: string[] = [];
    const client = {
      get: () => Promise.resolve({}),
      post: (path: string) => {
        posts.push(path);
        return Promise.resolve({});
      },
      put: () => Promise.resolve({}),
      patch: () => Promise.resolve({}),
      delete: () => Promise.resolve({}),
    };
    const g = mod.guestSupport(client) as {
      requestCode: (email: string, captcha: string | undefined) => Promise<unknown>;
      createTicket: (spec: unknown) => Promise<unknown>;
      viewTicket: (token: string) => Promise<unknown>;
    };
    void g.requestCode('a@b.test', undefined);
    void g.createTicket({});
    void g.viewTicket('t');
    expect(posts).toEqual([
      '/support/guest/codes',
      '/support/guest/tickets',
      '/support/guest/tickets/view',
    ]);
  });

  it('routes knowledge-base calls through /support/kb', () => {
    const gets: string[] = [];
    const client = {
      get: (path: string) => {
        gets.push(path);
        return Promise.resolve({});
      },
      post: () => Promise.resolve({}),
      put: () => Promise.resolve({}),
      patch: () => Promise.resolve({}),
      delete: () => Promise.resolve({}),
    };
    const k = mod.kb(client) as {
      categories: () => Promise<unknown>;
      article: (slug: string) => Promise<unknown>;
      search: (q: string) => Promise<unknown>;
    };
    void k.categories();
    void k.article('a slug');
    void k.search('help me');
    expect(gets).toEqual([
      '/support/kb/categories',
      '/support/kb/articles/a%20slug',
      '/support/kb/search?q=help%20me',
    ]);
  });

  it('routes staff calls through /admin/support', () => {
    const gets: string[] = [];
    const posts: string[] = [];
    const patches: string[] = [];
    const client = {
      get: (path: string) => {
        gets.push(path);
        return Promise.resolve({});
      },
      post: (path: string) => {
        posts.push(path);
        return Promise.resolve({});
      },
      put: () => Promise.resolve({}),
      patch: (path: string) => {
        patches.push(path);
        return Promise.resolve({});
      },
      delete: () => Promise.resolve({}),
    };
    const s = mod.staffSupport(client) as {
      tickets: () => Promise<unknown>;
      addNote: (id: string, body: string) => Promise<unknown>;
      update: (id: string, patch: unknown) => Promise<unknown>;
      macros: () => Promise<unknown>;
    };
    const kbStaff = mod.staffKb(client) as {
      articles: () => Promise<unknown>;
      revisions: (id: string) => Promise<unknown>;
      restore: (id: string, revision: number) => Promise<unknown>;
    };
    void s.tickets();
    void s.addNote('t', 'hi');
    void s.update('t', {});
    void s.macros();
    void kbStaff.articles();
    void kbStaff.revisions('a');
    void kbStaff.restore('a', 2);
    expect(gets).toEqual([
      '/admin/support/tickets',
      '/admin/support/macros',
      '/admin/support/kb/articles',
      '/admin/support/kb/articles/a/revisions',
    ]);
    expect(posts).toEqual([
      '/admin/support/tickets/t/notes',
      '/admin/support/kb/articles/a/revisions/2/restore',
    ]);
    expect(patches).toEqual(['/admin/support/tickets/t']);
  });
});
