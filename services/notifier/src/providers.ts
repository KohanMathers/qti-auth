import type { QtiauthConfig } from '@qtiauth/config';

import { consoleProvider } from './console.ts';
import { smtpProvider } from './smtp.ts';

export type EmailConfig = QtiauthConfig['email'];
export type EmailProviderName = EmailConfig['provider'];

export interface Mailbox {
  address: string;
  name: string | null;
}

export interface EmailAttachment {
  filename: string;
  content_type: string;
  content: string;
}

export interface EmailMessage {
  id: string;
  from: Mailbox;
  to: Mailbox;
  subject: string;
  text: string;
  html: string;
  attachments: EmailAttachment[];
}

export interface SendResult {
  provider_message_id: string;
}

export interface EmailProvider {
  name: EmailProviderName;
  send: (message: EmailMessage) => Promise<SendResult>;
  close: () => Promise<void>;
}

export interface ProviderOptions {
  write?: (text: string) => void;
}

export function createProvider(config: EmailConfig, options: ProviderOptions = {}): EmailProvider {
  switch (config.provider) {
    case 'console':
      return consoleProvider(options.write);
    case 'smtp':
      return smtpProvider(config.smtp);
  }
}
