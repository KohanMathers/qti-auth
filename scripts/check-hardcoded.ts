import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

export interface Rule {
  id: string;
  pattern: string;
  message: string;
}

export interface RulesFile {
  scanPaths: string[];
  ignoreFiles: string[];
  rules: Rule[];
}

export interface Finding {
  file: string;
  line: number;
  column: number;
  ruleId: string;
  match: string;
  message: string;
}

export function scanText(file: string, text: string, rules: Rule[]): Finding[] {
  const findings: Finding[] = [];
  const lines = text.split('\n');
  for (const rule of rules) {
    const regex = new RegExp(rule.pattern, 'gi');
    lines.forEach((content, index) => {
      for (const match of content.matchAll(regex)) {
        findings.push({
          file,
          line: index + 1,
          column: match.index + 1,
          ruleId: rule.id,
          match: match[0],
          message: rule.message,
        });
      }
    });
  }
  return findings.sort((a, b) => a.line - b.line || a.column - b.column);
}

function isBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8000).includes(0);
}

function listTrackedFiles(root: string, paths: string[]): string[] {
  const output = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...paths],
    {
      cwd: root,
      encoding: 'utf8',
    },
  );
  return output.split('\0').filter(Boolean);
}

function main(): void {
  const root = join(import.meta.dirname, '..');
  const config = JSON.parse(
    readFileSync(join(import.meta.dirname, 'hardcoded-rules.json'), 'utf8'),
  ) as RulesFile;

  const findings = listTrackedFiles(root, config.scanPaths)
    .filter((file) => !config.ignoreFiles.includes(basename(file)) && existsSync(join(root, file)))
    .flatMap((file) => {
      const buffer = readFileSync(join(root, file));
      return isBinary(buffer) ? [] : scanText(file, buffer.toString('utf8'), config.rules);
    });

  if (findings.length === 0) {
    console.log('No hardcoded deployment-specific values found.');
    return;
  }

  for (const f of findings) {
    console.error(
      `${f.file}:${String(f.line)}:${String(f.column)}  [${f.ruleId}] "${f.match}"  ${f.message}`,
    );
  }
  console.error(`\n${String(findings.length)} hardcoded value(s) found.`);
  process.exitCode = 1;
}

if (import.meta.main) {
  main();
}
