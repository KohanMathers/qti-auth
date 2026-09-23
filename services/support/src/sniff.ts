const JPEG = Uint8Array.of(0xff, 0xd8, 0xff);
const PNG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const GIF87 = ascii('GIF87a');
const GIF89 = ascii('GIF89a');
const PDF = ascii('%PDF-');
const RIFF = ascii('RIFF');
const WEBP = ascii('WEBP');

const MARKUP =
  /^\s*(?:<\?xml|<!--|<!doctype\b|<html\b|<head\b|<body\b|<script\b|<svg\b|<iframe\b|<meta\b|<link\b)/i;

export type SniffedAttachment = { ok: true; contentType: string; image: boolean } | { ok: false };

function ascii(value: string): Uint8Array {
  return Uint8Array.from(value, (char) => char.charCodeAt(0));
}

function startsWith(bytes: Uint8Array, prefix: Uint8Array, offset = 0): boolean {
  if (bytes.byteLength < offset + prefix.byteLength) return false;
  for (let index = 0; index < prefix.byteLength; index += 1) {
    if (bytes[offset + index] !== prefix[index]) return false;
  }
  return true;
}

function plainText(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  const sample = text.replace(/^\uFEFF/, '').slice(0, 512);
  return !MARKUP.test(sample) && !/<script\b/i.test(sample);
}

export function sniffAttachment(bytes: Uint8Array): SniffedAttachment {
  if (bytes.byteLength === 0) return { ok: false };
  if (startsWith(bytes, JPEG)) return { ok: true, contentType: 'image/jpeg', image: true };
  if (startsWith(bytes, PNG)) return { ok: true, contentType: 'image/png', image: true };
  if (startsWith(bytes, GIF87) || startsWith(bytes, GIF89)) {
    return { ok: true, contentType: 'image/gif', image: true };
  }
  if (startsWith(bytes, RIFF) && startsWith(bytes, WEBP, 8)) {
    return { ok: true, contentType: 'image/webp', image: true };
  }
  if (startsWith(bytes, PDF)) return { ok: true, contentType: 'application/pdf', image: false };
  if (plainText(bytes)) return { ok: true, contentType: 'text/plain', image: false };
  return { ok: false };
}

export function safeFilename(filename: string): string {
  const base = filename.split(/[/\\]/).pop()?.trim() ?? '';
  const cleaned = base
    .replaceAll(/[^\w.\- ]+/gu, '_')
    .replaceAll(/^[_.]+/gu, '')
    .slice(0, 120);
  return cleaned === '' ? 'attachment' : cleaned;
}

export function contentDisposition(filename: string): string {
  return `attachment; filename="${safeFilename(filename)}"`;
}

export function decodeBase64(value: string): Uint8Array | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length % 4 !== 0) return undefined;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(trimmed)) return undefined;
  const bytes = Buffer.from(trimmed, 'base64');
  if (bytes.toString('base64') !== trimmed) return undefined;
  return new Uint8Array(bytes);
}
