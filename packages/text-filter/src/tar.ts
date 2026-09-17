function ascii(bytes: Uint8Array): string {
  return new TextDecoder('latin1').decode(bytes).split('\0')[0] ?? '';
}

function octal(bytes: Uint8Array): number {
  const text = ascii(bytes).trim();
  return text === '' ? 0 : Number.parseInt(text, 8);
}

export function untar(buffer: Uint8Array): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header[0] === 0) break;
    const name = ascii(header.subarray(0, 100));
    const prefix = ascii(header.subarray(345, 500));
    const path = prefix === '' ? name : `${prefix}/${name}`;
    const size = octal(header.subarray(124, 136));
    const type = header[156] ?? 0;
    offset += 512;
    if ((type === 0 || type === 48) && path !== '') {
      files.set(path, buffer.subarray(offset, offset + size));
    }
    offset += Math.ceil(size / 512) * 512;
  }
  return files;
}
