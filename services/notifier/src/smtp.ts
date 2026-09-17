import nodemailer from 'nodemailer';

import type { EmailConfig, EmailProvider } from './providers.ts';

export type SmtpConfig = EmailConfig['smtp'];

export function smtpTransportOptions(config: SmtpConfig) {
  return {
    host: config.host,
    port: config.port,
    secure: config.security === 'tls',
    requireTLS: config.security === 'starttls',
    ignoreTLS: config.security === 'none',
    ...(config.user === null ? {} : { auth: { user: config.user, pass: config.password } }),
    connectionTimeout: config.connect_timeout,
    greetingTimeout: config.connect_timeout,
    socketTimeout: config.send_timeout,
    pool: true,
  };
}

export function smtpProvider(config: SmtpConfig): EmailProvider {
  const transport = nodemailer.createTransport(smtpTransportOptions(config));
  return {
    name: 'smtp',
    send: async (message) => {
      const info = await transport.sendMail({
        from: { name: message.from.name ?? '', address: message.from.address },
        to:
          message.to.name === null ? message.to.address : { ...message.to, name: message.to.name },
        subject: message.subject,
        text: message.text,
        html: message.html,
        headers: { 'X-QTIAuth-Delivery-ID': message.id },
      });
      return { provider_message_id: info.messageId };
    },
    close: () => {
      transport.close();
      return Promise.resolve();
    },
  };
}
