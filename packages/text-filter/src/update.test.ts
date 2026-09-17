import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { LIST_SOURCE_URLS, updateLists } from './update.ts';
import { LEGACY_LDNOOBW_FILE, LIST_FILES, parseWordList } from './words.ts';

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function u16(value: number): Uint8Array {
  return Uint8Array.of(value & 0xff, (value >> 8) & 0xff);
}

function u32(value: number): Uint8Array {
  return concat(u16(value), u16(value >> 16));
}

function zipStore(files: Record<string, string>): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = encoder.encode(text);
    const nameBytes = encoder.encode(name);
    const local = concat(
      Uint8Array.of(0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
      u32(data.length),
      u32(data.length),
      u16(nameBytes.length),
      u16(0),
      nameBytes,
      data,
    );
    locals.push(local);
    centrals.push(
      concat(
        Uint8Array.of(0x50, 0x4b, 0x01, 0x02, 0x14, 0, 0x14, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
        u32(data.length),
        u32(data.length),
        u16(nameBytes.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        nameBytes,
      ),
    );
    offset += local.length;
  }
  const central = concat(...centrals);
  return concat(
    ...locals,
    central,
    concat(
      Uint8Array.of(0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0),
      u16(centrals.length),
      u16(centrals.length),
      u32(central.length),
      u32(offset),
      u16(0),
    ),
  );
}

function tarStore(files: Record<string, string>): Uint8Array {
  const encoder = new TextEncoder();
  const blocks: Uint8Array[] = [];
  for (const [name, text] of Object.entries(files)) {
    const data = encoder.encode(text);
    const header = new Uint8Array(512);
    encoder.encodeInto(name, header);
    encoder.encodeInto('0000644\0', header.subarray(100));
    encoder.encodeInto('0000000\0', header.subarray(108));
    encoder.encodeInto('0000000\0', header.subarray(116));
    const size = data.length.toString(8).padStart(11, '0');
    encoder.encodeInto(`${size}\0`, header.subarray(124));
    encoder.encodeInto('0', header.subarray(156));
    encoder.encodeInto('ustar\0', header.subarray(257));
    encoder.encodeInto('00', header.subarray(263));
    header.fill(0x20, 148, 156);
    let checksum = 0;
    for (const byte of header) checksum += byte;
    encoder.encodeInto(`${checksum.toString(8).padStart(6, '0')}\0 `, header.subarray(148));
    blocks.push(header, data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad > 0) blocks.push(new Uint8Array(pad));
  }
  blocks.push(new Uint8Array(1024));
  return concat(...blocks);
}

describe('updateLists', () => {
  it('writes space-stripped LDNOOBW and the derived word lists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qtiauth-update-'));
    await writeFile(join(dir, LEGACY_LDNOOBW_FILE), 'oldenglish\n');
    const files = new Map<string, Uint8Array>([
      [
        LIST_SOURCE_URLS.ldnoobw('abc1234', 'en'),
        new TextEncoder().encode('two girls one cup\ncunt\n'),
      ],
      [LIST_SOURCE_URLS.ldnoobw('abc1234', 'fr'), new TextEncoder().encode('putain\ncunt\n')],
      [
        LIST_SOURCE_URLS.scowl,
        gzipSync(
          tarStore({
            'scowl-2020.12.07/final/english-words.10': 'the\n',
            'scowl-2020.12.07/final/english-words.70': 'classic\nassassin\n',
          }),
        ),
      ],
      [LIST_SOURCE_URLS.ssa, zipStore({ 'yob2022.txt': 'Mary,F,1\nJohn,M,1\n' })],
      [LIST_SOURCE_URLS.onsBoys, new TextEncoder().encode('name\nOliver\n')],
      [
        LIST_SOURCE_URLS.onsGirls,
        zipStore({
          'xl/sharedStrings.xml':
            '<sst><si><t>Cover</t></si><si><t>Name</t></si><si><t>Olivia</t></si></sst>',
          'xl/worksheets/sheet1.xml':
            '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>',
          'xl/worksheets/sheet2.xml':
            '<worksheet><sheetData><row r="5"><c r="B5" t="s"><v>1</v></c></row><row r="6"><c r="B6" t="s"><v>2</v></c></row></sheetData></worksheet>',
        }),
      ],
      [
        LIST_SOURCE_URLS.surnames,
        new TextEncoder().encode(
          'SMITH          1.006  1.006      1\nJONES          0.5    1.5        2\n',
        ),
      ],
      [
        LIST_SOURCE_URLS.cities,
        zipStore({
          'cities15000.txt': '1\tScunthorpe\tScunthorpe\n2\tSpringfield\tSpringfield\n',
        }),
      ],
      [LIST_SOURCE_URLS.admin1, new TextEncoder().encode('US.CA\tCalifornia\tCalifornia\t1\n')],
    ]);

    const result = await updateLists({
      dir,
      ldnoobwCommit: 'abc1234',
      fetch: (url) => {
        const body = files.get(url);
        if (body === undefined) return Promise.resolve(new Response('missing', { status: 404 }));
        return Promise.resolve(new Response(body));
      },
    });

    expect(result.ldnoobwCommit).toBe('abc1234');
    expect(parseWordList(await readFile(join(dir, LIST_FILES.ldnoobw), 'utf8'))).toEqual([
      'cunt',
      'putain',
      'twogirlsonecup',
    ]);
    await expect(access(join(dir, LEGACY_LDNOOBW_FILE))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(parseWordList(await readFile(join(dir, LIST_FILES.dictionary), 'utf8'))).toEqual([
      'assassin',
      'classic',
      'the',
    ]);
    expect(parseWordList(await readFile(join(dir, LIST_FILES.names), 'utf8'))).toEqual([
      'john',
      'mary',
      'oliver',
      'olivia',
    ]);
    expect(parseWordList(await readFile(join(dir, LIST_FILES.surnames), 'utf8'))).toEqual([
      'jones',
      'smith',
    ]);
    expect(parseWordList(await readFile(join(dir, LIST_FILES.places), 'utf8'))).toEqual([
      'california',
      'scunthorpe',
      'springfield',
    ]);
    expect(await readFile(join(dir, LIST_FILES.allow), 'utf8')).toBe('\n');
  });

  it('rejects a commit that is not a SHA', async () => {
    await expect(updateLists({ dir: tmpdir(), ldnoobwCommit: 'HEAD' })).rejects.toThrow(
      '--ldnoobw must be a git commit SHA',
    );
  });

  it('requires the English LDNOOBW file', async () => {
    await expect(
      updateLists({
        dir: await mkdtemp(join(tmpdir(), 'qtiauth-update-')),
        ldnoobwCommit: 'abc1234',
        fetch: () => Promise.resolve(new Response('missing', { status: 404 })),
      }),
    ).rejects.toThrow(/failed with 404/);
  });
});
