import { createServer } from 'node:http';

import { health } from './health.ts';

const SERVICE_NAME = 'template-service';
const port = Number(process.env['PORT'] ?? 8080);

const server = createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(health(SERVICE_NAME)));
    return;
  }
  res.writeHead(404).end();
});

server.listen(port);

process.on('SIGTERM', () => {
  server.close();
});
