import { describe, expect, it } from 'vitest';

import { contentDisposition, decodeBase64, sniffAttachment } from './sniff.ts';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('sniffAttachment', () => {
  it('accepts images, PDF and plain text, and rejects HTML whatever it is named', () => {
    expect(sniffAttachment(PNG)).toEqual({ ok: true, contentType: 'image/png', image: true });
    expect(sniffAttachment(Uint8Array.of(0xff, 0xd8, 0xff, 0x00))).toMatchObject({
      contentType: 'image/jpeg',
      image: true,
    });
    expect(sniffAttachment(new TextEncoder().encode('%PDF-1.4\n'))).toMatchObject({
      contentType: 'application/pdf',
      image: false,
    });
    expect(sniffAttachment(new TextEncoder().encode('See the log.\n'))).toEqual({
      ok: true,
      contentType: 'text/plain',
      image: false,
    });

    const html = new TextEncoder().encode(
      '<!DOCTYPE html><html><body><script>alert(1)</script></body></html>',
    );
    expect(sniffAttachment(html)).toEqual({ ok: false });
    expect(
      sniffAttachment(new TextEncoder().encode('<html><script>alert(1)</script></html>')),
    ).toEqual({ ok: false });
    expect(sniffAttachment(new TextEncoder().encode('<svg onload="alert(1)"></svg>'))).toEqual({
      ok: false,
    });
    expect(sniffAttachment(Uint8Array.of(0x00, 0x01, 0x02))).toEqual({ ok: false });
    expect(sniffAttachment(new Uint8Array())).toEqual({ ok: false });
  });
});

describe('contentDisposition', () => {
  it('forces a download and drops path and markup from the filename', () => {
    expect(contentDisposition('../photo.png')).toBe('attachment; filename="photo.png"');
    expect(contentDisposition('<script>.html')).toBe('attachment; filename="script_.html"');
    expect(contentDisposition('   ')).toBe('attachment; filename="attachment"');
  });
});

describe('decodeBase64', () => {
  it('decodes padded base64 and rejects a truncated payload', () => {
    expect(decodeBase64(PNG.toString('base64'))).toEqual(new Uint8Array(PNG));
    expect(decodeBase64('abc')).toBeUndefined();
    expect(decodeBase64('@@@@')).toBeUndefined();
  });
});
