import { createServer } from 'node:net';

import { simpleParser } from 'mailparser';
import { SMTPServer } from 'smtp-server';

export interface ReceivedEmail {
  from: string;
  to: string[];
  subject: string;
  text: string;
  html: string;
  headers: Map<string, unknown>;
  user: string | null;
}

export interface TestSmtpServer {
  port: number;
  received: ReceivedEmail[];
  stop: () => Promise<void>;
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address === null || typeof address === 'string') {
          reject(new Error('No port assigned'));
          return;
        }
        resolve(address.port);
      });
    });
  });
}

export async function startTestSmtpServer(
  options: { port?: number; users?: Record<string, string> } = {},
): Promise<TestSmtpServer> {
  const received: ReceivedEmail[] = [];
  const users = options.users;
  const server = new SMTPServer({
    disabledCommands: ['STARTTLS'],
    disableReverseLookup: true,
    allowInsecureAuth: true,
    authOptional: users === undefined,
    logger: false,
    onAuth: (auth, _session, callback) => {
      if (users?.[auth.username ?? ''] === auth.password) {
        callback(null, { user: auth.username });
      } else {
        callback(new Error('Invalid username or password'));
      }
    },
    onData: (stream, session, callback) => {
      simpleParser(stream).then(
        (parsed) => {
          received.push({
            from: session.envelope.mailFrom ? session.envelope.mailFrom.address : '',
            to: session.envelope.rcptTo.map((rcpt) => rcpt.address),
            subject: parsed.subject ?? '',
            text: parsed.text ?? '',
            html: typeof parsed.html === 'string' ? parsed.html : '',
            headers: parsed.headers,
            user: typeof session.user === 'string' ? session.user : null,
          });
          callback();
        },
        (error: unknown) => {
          callback(error instanceof Error ? error : new Error(String(error)));
        },
      );
    },
  });
  const port = options.port ?? (await freePort());
  await new Promise<void>((resolve, reject) => {
    server.server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.server.off('error', reject);
      resolve();
    });
  });
  return {
    port,
    received,
    stop: () =>
      new Promise((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}
