import { Hono } from 'hono';
import { cors } from 'hono/cors';

import { registerRoutes } from './routes.js';

export function createApp() {
  const app = new Hono();

  // Public OAuth endpoints must be reachable by any client (server-side, native apps, etc.)
  app.use('/oauth/token', cors({ origin: '*' }));
  app.use('/oauth/userinfo', cors({ origin: '*' }));
  app.use('/oauth/revoke', cors({ origin: '*' }));
  app.use('/oauth/introspect', cors({ origin: '*' }));
  app.use('/.well-known/*', cors({ origin: '*' }));

  // All other routes: explicit allowlist keeps CORS tight across prod/staging surfaces.
  app.use('/*', cors({
    origin: [
      'https://account.quietterminal.co.uk',
      'https://account-staging.quietterminal.co.uk',
      'https://support.quietterminal.co.uk',
      'https://support-staging.quietterminal.co.uk',
    ],
    credentials: true,
  }));

  registerRoutes(app);

  return app;
}
