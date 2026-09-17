import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';

export interface MockOidcUser {
  sub: string;
  email?: string;
  email_verified?: boolean;
  birthdate?: string;
  name?: string;
}

export interface MockOidc {
  issuer: string;
  clientId: string;
  clientSecret: string;
  setUser: (user: MockOidcUser) => void;
  stop: () => Promise<void>;
}

export function startMockOidc(initial: MockOidcUser): Promise<MockOidc> {
  const clientId = 'test-client';
  const clientSecret = 'test-secret';
  const codes = new Map<string, MockOidcUser>();
  const tokens = new Map<string, MockOidcUser>();
  let user = initial;

  const handler = async (request: IncomingMessage, response: ServerResponse) => {
    const host = request.headers.host ?? '127.0.0.1';
    const url = new URL(request.url ?? '/', `http://${host}`);
    if (url.pathname === '/.well-known/openid-configuration') {
      json(response, {
        issuer: `http://${host}`,
        authorization_endpoint: `http://${host}/authorize`,
        token_endpoint: `http://${host}/token`,
        userinfo_endpoint: `http://${host}/userinfo`,
        jwks_uri: `http://${host}/jwks`,
      });
      return;
    }
    if (url.pathname === '/authorize') {
      const redirect = url.searchParams.get('redirect_uri');
      const state = url.searchParams.get('state') ?? '';
      if (redirect === null) {
        response.writeHead(400);
        response.end();
        return;
      }
      const code = randomBytes(16).toString('hex');
      codes.set(code, user);
      const target = new URL(redirect);
      target.searchParams.set('code', code);
      target.searchParams.set('state', state);
      response.writeHead(302, { location: target.toString() });
      response.end();
      return;
    }
    if (url.pathname === '/token' && request.method === 'POST') {
      const body = await readBody(request);
      const params = new URLSearchParams(body);
      const code = params.get('code') ?? '';
      const profile = codes.get(code);
      codes.delete(code);
      if (profile === undefined || params.get('client_id') !== clientId) {
        response.writeHead(400);
        response.end('{"error":"invalid_grant"}');
        return;
      }
      const accessToken = `tok-${code}`;
      tokens.set(accessToken, profile);
      json(response, { access_token: accessToken, token_type: 'Bearer' });
      return;
    }
    if (url.pathname === '/userinfo') {
      const auth = request.headers.authorization ?? '';
      const profile = auth.startsWith('Bearer ') ? tokens.get(auth.slice(7)) : undefined;
      if (profile === undefined) {
        response.writeHead(401);
        response.end();
        return;
      }
      json(response, profile);
      return;
    }
    response.writeHead(404);
    response.end();
  };

  const server: Server = createServer((request, response) => {
    void handler(request, response);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      const issuer = `http://127.0.0.1:${String(port)}`;
      resolve({
        issuer,
        clientId,
        clientSecret,
        setUser: (next) => {
          user = next;
        },
        stop: () =>
          new Promise((done, fail) => {
            server.close((error) => {
              if (error) fail(error);
              else done();
            });
          }),
      });
    });
  });
}

function json(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    request.on('error', (error: Error) => {
      reject(error);
    });
  });
}
