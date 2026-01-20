import { Hono } from 'hono';
import { cors } from 'hono/cors';

import { registerRoutes } from './routes.js';

export function createApp() {
  const app = new Hono();

  // Explicit allowlist keeps CORS tight across prod/staging surfaces.
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
