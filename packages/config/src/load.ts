import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { type Document, isNode, LineCounter, parseDocument } from 'yaml';
import type * as z from 'zod';

import { ConfigError, type ConfigIssue, type ConfigPath } from './errors.ts';
import { interpolate } from './interpolate.ts';

export const DEFAULT_CONFIG_PATH = 'config/qtiauth.yaml';
export const CONFIG_PATH_ENV = 'QTIAUTH_CONFIG';

type Env = Readonly<Record<string, string | undefined>>;

export interface ParseConfigOptions {
  source: string;
  env: Env;
  baseDir: string;
  readFile?: (path: string) => Promise<string>;
}

export interface LoadConfigOptions {
  path?: string;
  env?: Env;
}

export function resolveConfigPath(env: Env): string {
  const fromEnv = env[CONFIG_PATH_ENV];
  if (fromEnv) return fromEnv;
  return DEFAULT_CONFIG_PATH;
}

function locate(
  doc: Document,
  lineCounter: LineCounter,
  path: ConfigPath,
): Pick<ConfigIssue, 'line' | 'column'> {
  for (let depth = path.length; depth >= 0; depth--) {
    const node: unknown = depth === 0 ? doc.contents : doc.getIn(path.slice(0, depth), true);
    if (isNode(node) && node.range) {
      const { line, col } = lineCounter.linePos(node.range[0]);
      return { line, column: col };
    }
  }
  return {};
}

function schemaIssues(error: z.ZodError): ConfigIssue[] {
  return error.issues.flatMap((issue) => {
    const path = issue.path.map((segment) =>
      typeof segment === 'symbol' ? String(segment) : segment,
    );
    if (issue.code === 'unrecognized_keys') {
      return issue.keys.map((key) => ({ path: [...path, key], message: 'Unknown setting' }));
    }
    return [{ path, message: issue.message }];
  });
}

export async function parseConfig<S extends z.ZodType>(
  schema: S,
  text: string,
  options: ParseConfigOptions,
): Promise<z.output<S>> {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter, prettyErrors: false });

  const [syntaxError] = doc.errors;
  if (syntaxError) {
    const { line, col } = lineCounter.linePos(syntaxError.pos[0]);
    throw new ConfigError(options.source, [
      { path: [], message: syntaxError.message, line, column: col },
    ]);
  }

  const raw: unknown = doc.toJS() ?? {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError(options.source, [
      {
        path: [],
        message: 'Config must be a mapping of settings',
        ...locate(doc, lineCounter, []),
      },
    ]);
  }

  const interpolated = await interpolate(raw, options);
  const result = schema.safeParse(interpolated.value);
  const issues = [...interpolated.issues, ...(result.success ? [] : schemaIssues(result.error))];

  if (issues.length > 0 || !result.success) {
    throw new ConfigError(
      options.source,
      issues
        .map((issue) => ({ ...issue, ...locate(doc, lineCounter, issue.path) }))
        .sort((a, b) => (a.line ?? 0) - (b.line ?? 0) || (a.column ?? 0) - (b.column ?? 0)),
    );
  }
  return result.data;
}

export async function loadConfig<S extends z.ZodType>(
  schema: S,
  options: LoadConfigOptions = {},
): Promise<z.output<S>> {
  const env = options.env ?? process.env;
  const path = options.path ?? resolveConfigPath(env);

  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'read failed';
    throw new ConfigError(path, [{ path: [], message: `Can't read config file (${code})` }]);
  }

  return parseConfig(schema, text, { source: path, env, baseDir: dirname(resolve(path)) });
}

export async function loadConfigOrExit<S extends z.ZodType>(
  schema: S,
  options: LoadConfigOptions = {},
): Promise<z.output<S>> {
  try {
    return await loadConfig(schema, options);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
