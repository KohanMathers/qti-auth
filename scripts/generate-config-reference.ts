import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Schema {
  type?: string | string[];
  description?: string;
  default?: unknown;
  properties?: Record<string, Schema>;
  additionalProperties?: boolean | Schema;
  patternProperties?: Record<string, Schema>;
  items?: Schema;
  anyOf?: Schema[];
  oneOf?: Schema[];
  allOf?: Schema[];
  enum?: unknown[];
  const?: unknown;
  format?: string;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  required?: string[];
}

export interface Row {
  path: string;
  type: string;
  defaultText: string;
  description: string;
  constraints: string;
}

const DURATION = /^\d+(?:ms|s|m|h|d|w)$/;

function isDurationPattern(pattern: string): boolean {
  return pattern.includes('ms|s|m|h|d|w');
}

function isDurationSchema(schema: Schema): boolean {
  if (schema.type !== 'string') return false;
  if (schema.pattern && isDurationPattern(schema.pattern)) return true;
  if (typeof schema.default === 'string' && DURATION.test(schema.default)) return true;
  return false;
}

function typeName(schema: Schema): string {
  if (isDurationSchema(schema)) return 'duration';
  if (schema.enum) return schema.enum.map((value) => JSON.stringify(value)).join(' | ');
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (schema.anyOf) return schema.anyOf.map(typeName).join(' | ');
  if (schema.oneOf) return schema.oneOf.map(typeName).join(' | ');
  if (Array.isArray(schema.type)) return schema.type.join(' | ');
  if (schema.type === 'array') return `${typeName(schema.items ?? {})}[]`;
  if (schema.type === 'object') {
    if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      return `map<string, ${typeName(schema.additionalProperties)}>`;
    }
    if (schema.patternProperties && Object.keys(schema.patternProperties).length > 0) {
      const first = Object.values(schema.patternProperties)[0];
      return `map<string, ${typeName(first ?? {})}>`;
    }
    return 'object';
  }
  return schema.type ?? 'any';
}

function formatDefault(value: unknown): string {
  if (value === undefined) return '';
  if (value === null) return '`null`';
  if (typeof value === 'string') return value === '' ? '`""`' : `\`"${value}"\``;
  if (typeof value === 'boolean' || typeof value === 'number') return `\`${String(value)}\``;
  if (Array.isArray(value)) {
    if (value.length === 0) return '`[]`';
    return `\`${JSON.stringify(value)}\``;
  }
  if (typeof value === 'object') {
    if (Object.keys(value).length === 0) return '`{}`';
    return `\`${JSON.stringify(value)}\``;
  }
  return `\`${JSON.stringify(value)}\``;
}

function constraints(schema: Schema): string {
  const parts: string[] = [];
  if (schema.format && schema.format !== 'hostname') parts.push(schema.format);
  if (schema.minLength !== undefined && schema.maxLength !== undefined) {
    parts.push(`${String(schema.minLength)}–${String(schema.maxLength)} characters`);
  } else if (schema.minLength !== undefined) {
    parts.push(`≥ ${String(schema.minLength)} characters`);
  } else if (schema.maxLength !== undefined) {
    parts.push(`≤ ${String(schema.maxLength)} characters`);
  }
  if (schema.minimum !== undefined && schema.maximum !== undefined) {
    parts.push(`${String(schema.minimum)}–${String(schema.maximum)}`);
  } else if (schema.minimum !== undefined) {
    parts.push(`≥ ${String(schema.minimum)}`);
  } else if (schema.maximum !== undefined) {
    parts.push(`≤ ${String(schema.maximum)}`);
  }
  if (schema.exclusiveMinimum !== undefined) parts.push(`> ${String(schema.exclusiveMinimum)}`);
  if (schema.exclusiveMaximum !== undefined) parts.push(`< ${String(schema.exclusiveMaximum)}`);
  if (schema.minItems !== undefined) parts.push(`≥ ${String(schema.minItems)} items`);
  if (schema.maxItems !== undefined) parts.push(`≤ ${String(schema.maxItems)} items`);
  return parts.join(', ');
}

function hasChildren(schema: Schema): boolean {
  return Boolean(schema.properties && Object.keys(schema.properties).length > 0);
}

function escapeCell(text: string): string {
  return text.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

export function collectRows(schema: Schema, path: string): Row[] {
  const rows: Row[] = [];
  const description = schema.description ?? '';
  if (path !== '') {
    rows.push({
      path,
      type: typeName(schema),
      defaultText: formatDefault(schema.default),
      description,
      constraints: constraints(schema),
    });
  }
  if (hasChildren(schema)) {
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      const childPath = path === '' ? key : `${path}.${key}`;
      rows.push(...collectRows(child, childPath));
    }
  }
  return rows;
}

function topLevelSections(schema: Schema): { key: string; child: Schema }[] {
  return Object.entries(schema.properties ?? {}).map(([key, child]) => ({ key, child }));
}

function renderSection(key: string, child: Schema): string {
  const heading = `## \`${key}\``;
  const intro = child.description ? `${child.description}\n\n` : '';
  const rows = collectRows(child, key);
  if (rows.length === 0) return `${heading}\n\n${intro}`.trimEnd() + '\n';
  const header = '| Setting | Type | Default | Description |';
  const divider = '| --- | --- | --- | --- |';
  const body = rows
    .map((row) => {
      const description = row.constraints
        ? `${row.description} (${row.constraints})`.trim()
        : row.description;
      return `| \`${row.path}\` | ${escapeCell(row.type)} | ${escapeCell(row.defaultText)} | ${escapeCell(description)} |`;
    })
    .join('\n');
  return `${heading}\n\n${intro}${header}\n${divider}\n${body}\n`;
}

export function renderReference(schema: Schema): string {
  const preamble = [
    '# Config reference',
    '',
    'Every setting in `config/qtiauth.yaml`, with its type, default and one-line description. Generated from `config/qtiauth.schema.json` by `pnpm config:reference`; do not edit by hand.',
    '',
    'For how config is loaded, validated and referenced from `.env`, see [configuration.md](configuration.md). For what each section is for, see the service-specific docs linked from there.',
    '',
  ].join('\n');
  const sections = topLevelSections(schema)
    .map(({ key, child }) => renderSection(key, child))
    .join('\n');
  return `${preamble}\n${sections}`;
}

function main(): void {
  const root = join(import.meta.dirname, '..');
  const check = process.argv.includes('--check');
  const schema = JSON.parse(
    readFileSync(join(root, 'config/qtiauth.schema.json'), 'utf8'),
  ) as Schema;
  const output = renderReference(schema);
  const path = join(root, 'docs/config-reference.md');
  if (check) {
    const current = readFileSync(path, 'utf8');
    if (current !== output) {
      console.error(
        'docs/config-reference.md is out of date. Run pnpm config:reference to regenerate.',
      );
      process.exitCode = 1;
      return;
    }
    console.log('docs/config-reference.md is up to date.');
    return;
  }
  writeFileSync(path, output);
  console.log(`Wrote ${path}`);
}

if (import.meta.main) {
  main();
}
