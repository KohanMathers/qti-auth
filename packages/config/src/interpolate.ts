import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { ConfigIssue, ConfigPath } from './errors.ts';

export interface InterpolateOptions {
  env: Readonly<Record<string, string | undefined>>;
  baseDir: string;
  readFile?: (path: string) => Promise<string>;
}

export interface InterpolateResult {
  value: unknown;
  issues: ConfigIssue[];
}

const REFERENCE_PATTERN = /\$(\$?)\{([^}]*)\}/g;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function readUtf8(path: string): Promise<string> {
  return readFile(path, 'utf8');
}

async function resolveReference(
  body: string,
  options: InterpolateOptions,
): Promise<{ value: string } | { error: string }> {
  if (body.startsWith('env:')) {
    const name = body.slice('env:'.length);
    if (!ENV_NAME_PATTERN.test(name)) {
      return { error: `Invalid environment variable name "${name}"` };
    }
    const value = options.env[name];
    if (value === undefined) return { error: `Environment variable ${name} is not set` };
    return { value };
  }
  if (body.startsWith('file:')) {
    const path = body.slice('file:'.length);
    if (!path) return { error: 'Missing file path in ${file:…}' };
    try {
      const contents = await (options.readFile ?? readUtf8)(resolve(options.baseDir, path));
      return { value: contents.replace(/\r?\n$/, '') };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? 'read failed';
      return { error: `Can't read ${path} (${code})` };
    }
  }
  return {
    error: `Unknown reference "\${${body}}". Use \${env:NAME} or \${file:/path}, or $\${…} for a literal`,
  };
}

async function interpolateString(
  input: string,
  path: ConfigPath,
  options: InterpolateOptions,
  issues: ConfigIssue[],
): Promise<string> {
  let output = '';
  let last = 0;
  for (const match of input.matchAll(REFERENCE_PATTERN)) {
    const [whole, escaped, body = ''] = match;
    output += input.slice(last, match.index);
    last = match.index + whole.length;
    if (escaped) {
      output += whole.slice(1);
      continue;
    }
    const resolved = await resolveReference(body, options);
    if ('error' in resolved) {
      issues.push({ path, message: resolved.error });
    } else {
      output += resolved.value;
    }
  }
  return output + input.slice(last);
}

async function walk(
  value: unknown,
  path: ConfigPath,
  options: InterpolateOptions,
  issues: ConfigIssue[],
): Promise<unknown> {
  if (typeof value === 'string') return interpolateString(value, path, options, issues);
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    for (const [index, item] of value.entries()) {
      items.push(await walk(item, [...path, index], options, issues));
    }
    return items;
  }
  if (value !== null && typeof value === 'object') {
    const entries: [string, unknown][] = [];
    for (const [key, item] of Object.entries(value)) {
      entries.push([key, await walk(item, [...path, key], options, issues)]);
    }
    return Object.fromEntries(entries);
  }
  return value;
}

export async function interpolate(
  value: unknown,
  options: InterpolateOptions,
): Promise<InterpolateResult> {
  const issues: ConfigIssue[] = [];
  const result = await walk(value, [], options, issues);
  return { value: result, issues };
}
