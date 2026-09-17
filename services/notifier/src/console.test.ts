import { describe, expect, it } from 'vitest';

import { consoleProvider } from './console.ts';

describe('consoleProvider', () => {
  it('prints the headers and the text part instead of sending', async () => {
    let printed = '';
    const provider = consoleProvider((text) => (printed += text));

    const result = await provider.send({
      id: 'delivery-1',
      from: { name: 'Example Auth', address: 'auth@example.com' },
      to: { name: null, address: 'someone@example.com' },
      subject: 'Your sign-in link',
      text: 'Open https://me.example.com/magic\n\n',
      html: '<p>Open the link</p>',
    });

    expect(result).toEqual({ provider_message_id: 'console-delivery-1' });
    const rule = '-'.repeat(72);
    expect(printed).toBe(
      [
        rule,
        'Email delivery-1',
        'From: Example Auth <auth@example.com>',
        'To: someone@example.com',
        'Subject: Your sign-in link',
        '',
        'Open https://me.example.com/magic',
        rule,
        '',
      ].join('\n'),
    );
  });
});
