import { unzip } from './zip.ts';

function decodeXml(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

function sharedStrings(xml: string): string[] {
  const strings: string[] = [];
  for (const item of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    const parts = [...(item[1] ?? '').matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((match) =>
      decodeXml(match[1] ?? ''),
    );
    strings.push(parts.join(''));
  }
  return strings;
}

function columnIndex(letters: string): number {
  let index = 0;
  for (const char of letters) index = index * 26 + (char.charCodeAt(0) - 64);
  return index;
}

function cellValue(attrs: string, inner: string, strings: readonly string[]): string {
  const raw = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? '';
  return attrs.includes('t="s"') ? (strings[Number(raw)] ?? '') : decodeXml(raw);
}

function sheetColumn(xml: string, strings: readonly string[], header: string): string[] {
  const wanted = header.toLowerCase();
  const cells = new Map<string, string>();
  const headers: { col: number; row: number }[] = [];
  for (const match of xml.matchAll(/<c r="([A-Z]+)(\d+)"([^>]*)>([\s\S]*?)<\/c>/g)) {
    const col = columnIndex(match[1] ?? 'A');
    const row = Number(match[2]);
    const value = cellValue(match[3] ?? '', match[4] ?? '', strings);
    cells.set(`${String(row)}:${String(col)}`, value);
    if (value.trim().toLowerCase() === wanted) headers.push({ col, row });
  }
  const values: string[] = [];
  for (const headerCell of headers) {
    for (const [key, value] of cells) {
      const [row, col] = key.split(':').map(Number);
      if (col === headerCell.col && (row ?? 0) > headerCell.row && value.trim() !== '') {
        values.push(value.trim());
      }
    }
  }
  return values;
}

export function xlsxColumn(buffer: Uint8Array, header: string): string[] {
  const files = unzip(buffer);
  const strings = sharedStrings(
    new TextDecoder().decode(files.get('xl/sharedStrings.xml') ?? new Uint8Array()),
  );
  const values: string[] = [];
  for (const [name, data] of files) {
    if (!/xl\/worksheets\/sheet\d+\.xml$/i.test(name.replaceAll('\\', '/'))) continue;
    values.push(...sheetColumn(new TextDecoder().decode(data), strings, header));
  }
  return values;
}
