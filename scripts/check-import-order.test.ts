import { describe, expect, it } from 'vitest';

import { compareSpecifiers, sortImports } from './check-import-order.ts';

describe('compareSpecifiers', () => {
  it('puts a module before its hyphenated siblings', () => {
    expect(compareSpecifiers('./age.ts', './age-assurance.ts')).toBeLessThan(0);
    expect(compareSpecifiers('./legal.ts', './legal-documents.ts')).toBeLessThan(0);
  });
});

describe('sortImports', () => {
  it('sorts each blank-line group on its own and keeps multi-line imports whole', () => {
    const source = [
      "import { b } from 'node:path';",
      "import { a } from 'node:crypto';",
      '',
      "import { z } from './zip.ts';",
      'import {',
      '  one,',
      '  two,',
      "} from './accounts.ts';",
      '',
      'export const x = 1;',
    ].join('\n');
    const result = sortImports('fixture.ts', source);
    expect(result.text).toBe(
      [
        "import { a } from 'node:crypto';",
        "import { b } from 'node:path';",
        '',
        'import {',
        '  one,',
        '  two,',
        "} from './accounts.ts';",
        "import { z } from './zip.ts';",
        '',
        'export const x = 1;',
      ].join('\n'),
    );
    expect(result.findings).toEqual([
      { file: 'fixture.ts', line: 1, expected: 'node:crypto', found: 'node:path' },
      { file: 'fixture.ts', line: 4, expected: './accounts.ts', found: './zip.ts' },
    ]);
  });

  it('leaves sorted files alone', () => {
    const source = "import a from './a.ts';\nimport b from './b.ts';\n";
    expect(sortImports('fixture.ts', source)).toEqual({ text: source, findings: [] });
  });
});
