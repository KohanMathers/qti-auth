import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { type RulesFile, scanText } from './check-hardcoded.ts';

const { rules } = JSON.parse(
  readFileSync(join(import.meta.dirname, 'hardcoded-rules.json'), 'utf8'),
) as RulesFile;

// Had to concatenate, the linter kept flagging this file
const brand = 'Q' + 'TI';
const domain = 'quiet' + 'terminal.co.uk';

const ruleIds = (text: string) => scanText('fixture.ts', text, rules).map((f) => f.ruleId);

describe('scanText', () => {
  it('flags the production domain', () => {
    expect(ruleIds(`const url = 'https://account.${domain}';`)).toContain('production-domain');
  });

  it('flags the company name with or without a space', () => {
    expect(ruleIds('// Quiet' + ' Terminal Interactive')).toContain('company-name');
    expect(ruleIds(`const a = '${'Quiet' + 'Terminal'}';`)).toContain('company-name');
  });

  it('flags the bare brand and brand prefixes', () => {
    expect(ruleIds(`const name = '${brand}';`)).toEqual(['brand-token']);
    expect(ruleIds(`const prefix = '${brand}_';`)).toEqual(['reserved-prefix']);
    expect(ruleIds(`const cookie = '${brand.toLowerCase()}_token';`)).toEqual(['reserved-prefix']);
  });

  it('allows the project name', () => {
    expect(ruleIds(`import x from '@${brand.toLowerCase()}auth/config'; // ${brand}Auth`)).toEqual(
      [],
    );
  });

  it('does not match the brand inside other words', () => {
    expect(ruleIds('const equity = antiquities;')).toEqual([]);
  });

  it('reports line and column', () => {
    const [finding] = scanText('a.ts', `ok\n  const x = '${brand}';`, rules);
    expect(finding).toMatchObject({ file: 'a.ts', line: 2, column: 14 });
  });
});
