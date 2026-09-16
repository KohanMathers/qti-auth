export type ConfigPath = readonly (string | number)[];

export interface ConfigIssue {
  path: ConfigPath;
  message: string;
  line?: number;
  column?: number;
}

export function formatPath(path: ConfigPath): string {
  let out = '';
  for (const segment of path) {
    out += typeof segment === 'number' ? `[${String(segment)}]` : out ? `.${segment}` : segment;
  }
  return out || '(root)';
}

function formatIssue(issue: ConfigIssue): string {
  const location =
    issue.line === undefined
      ? ''
      : ` (line ${String(issue.line)}, column ${String(issue.column ?? 1)})`;
  return `  ${formatPath(issue.path)}${location}: ${issue.message}`;
}

export class ConfigError extends Error {
  readonly source: string;
  readonly issues: readonly ConfigIssue[];

  constructor(source: string, issues: readonly ConfigIssue[]) {
    super(`Invalid config in ${source}:\n${issues.map(formatIssue).join('\n')}`);
    this.name = 'ConfigError';
    this.source = source;
    this.issues = issues;
  }
}
