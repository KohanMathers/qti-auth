import type { EmailMessage, EmailProvider, Mailbox } from './providers.ts';

function mailbox({ name, address }: Mailbox): string {
  return name === null ? address : `${name} <${address}>`;
}

export function formatConsoleEmail(message: EmailMessage): string {
  const rule = '-'.repeat(72);
  const attachments =
    message.attachments.length === 0
      ? []
      : [
          '',
          ...message.attachments.map(
            (attachment) =>
              `Attachment: ${attachment.filename} (${String(Buffer.from(attachment.content, 'base64').byteLength)} bytes)`,
          ),
        ];
  return [
    rule,
    `Email ${message.id}`,
    `From: ${mailbox(message.from)}`,
    `To: ${mailbox(message.to)}`,
    `Subject: ${message.subject}`,
    '',
    message.text.trimEnd(),
    ...attachments,
    rule,
    '',
  ].join('\n');
}

export function consoleProvider(
  write: (text: string) => void = (text) => process.stdout.write(text),
): EmailProvider {
  return {
    name: 'console',
    send: (message) => {
      write(formatConsoleEmail(message));
      return Promise.resolve({ provider_message_id: `console-${message.id}` });
    },
    close: () => Promise.resolve(),
  };
}
