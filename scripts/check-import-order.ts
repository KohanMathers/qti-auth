import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ImportOrderFinding {
  file: string;
  line: number;
  expected: string;
  found: string;
}

interface Statement {
  text: string;
  specifier: string;
  line: number;
}

const IMPORT_END = /(?:from\s+|import\s+)'([^']+)'(?:\s+with\s+\{[^}]*\})?;\s*$/;

function sortKey(specifier: string): string {
  return specifier.replace(/\.ts$/, '');
}

export function compareSpecifiers(a: string, b: string): number {
  return sortKey(a).localeCompare(sortKey(b), 'en');
}

function readStatements(lines: string[], start: number): { statements: Statement[]; end: number } {
  const statements: Statement[] = [];
  let index = start;
  while (index < lines.length && lines[index]?.startsWith('import ')) {
    const first = index;
    while (index < lines.length && !IMPORT_END.test(lines[index] ?? '')) index += 1;
    if (index >= lines.length) break;
    const specifier = IMPORT_END.exec(lines[index] ?? '')?.[1] ?? '';
    statements.push({
      text: lines.slice(first, index + 1).join('\n'),
      specifier,
      line: first + 1,
    });
    index += 1;
  }
  return { statements, end: index };
}

export function sortImports(
  file: string,
  text: string,
): { text: string; findings: ImportOrderFinding[] } {
  const lines = text.split('\n');
  const out: string[] = [];
  const findings: ImportOrderFinding[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (!line.startsWith('import ')) {
      out.push(line);
      index += 1;
      continue;
    }
    const { statements, end } = readStatements(lines, index);
    if (statements.length === 0) {
      out.push(line);
      index += 1;
      continue;
    }
    const sorted = statements.toSorted((a, b) => compareSpecifiers(a.specifier, b.specifier));
    const moved = statements.findIndex((statement, i) => statement !== sorted[i]);
    if (moved !== -1) {
      findings.push({
        file,
        line: statements[moved]?.line ?? 0,
        expected: sorted[moved]?.specifier ?? '',
        found: statements[moved]?.specifier ?? '',
      });
    }
    out.push(...sorted.map((statement) => statement.text));
    index = end;
  }
  return { text: out.join('\n'), findings };
}

function listSourceFiles(root: string): string[] {
  const output = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '*.ts'],
    { cwd: root, encoding: 'utf8' },
  );
  return output.split('\0').filter((file) => file !== '' && !file.includes('node_modules/'));
}

function main(): void {
  const root = join(import.meta.dirname, '..');
  const fix = process.argv.includes('--fix');
  const findings: ImportOrderFinding[] = [];
  for (const file of listSourceFiles(root)) {
    const path = join(root, file);
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    const result = sortImports(file, text);
    if (result.findings.length === 0) continue;
    if (fix) writeFileSync(path, result.text);
    findings.push(...result.findings);
  }

  if (findings.length === 0) {
    console.log('Imports are in order.');
    return;
  }
  for (const f of findings) {
    console.error(`${f.file}:${String(f.line)}  expected '${f.expected}' before '${f.found}'`);
  }
  if (fix) {
    console.log(`\nSorted imports in ${String(findings.length)} group(s).`);
    return;
  }
  console.error(
    `\n${String(findings.length)} import group(s) out of order. Run pnpm check:imports --fix.`,
  );
  process.exitCode = 1;
}

if (import.meta.main) {
  main();
}
