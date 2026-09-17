import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { QtiauthConfig } from '@qtiauth/config';
import {
  BRAND_VARIABLES,
  type EmailTemplateDefinition,
  escapeHtml,
  isCanonicalLocale,
  templateVariables,
} from '@qtiauth/email';
import mjml2html from 'mjml';

export const DEFAULT_TEMPLATES_DIR = join(import.meta.dirname, '../templates/email');

export const TEMPLATE_PARTS = ['subject', 'text', 'html'] as const;
export type TemplatePart = (typeof TEMPLATE_PARTS)[number];

const PART_SUFFIXES: Record<TemplatePart, string> = {
  subject: '.subject.txt',
  text: '.txt',
  html: '.mjml',
};

const PLACEHOLDER = /\{\{(.*?)\}\}/gs;
const VARIABLE_PATH = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/;
const TEMPLATE_FILE = /^([a-z][a-z0-9_]*)(\.subject\.txt|\.txt|\.mjml)$/;

export interface Brand {
  product_name: string;
  company_name: string;
  support_email: string;
  primary_color: string;
}

export interface RenderedEmail {
  locale: string;
  subject: string;
  text: string;
  html: string;
}

export interface TemplateSummary {
  name: string;
  locales: string[];
}

export interface TemplateSet {
  defaultLocale: string;
  locales: string[];
  templates: TemplateSummary[];
  resolveLocale: (template: string, locale: string) => string;
  render: (template: string, locale: string, variables: Record<string, unknown>) => RenderedEmail;
}

export interface LoadTemplatesOptions {
  definitions: Readonly<Record<string, EmailTemplateDefinition>>;
  dirs: readonly string[];
  defaultLocale: string;
  brand: Brand;
}

interface SourceFile {
  path: string;
  source: string;
}

type Compiled = Record<TemplatePart, string>;

export class TemplateError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Email templates are invalid:\n${issues.map((issue) => `  ${issue}`).join('\n')}`);
    this.name = 'TemplateError';
    this.issues = issues;
  }
}

export function brandFromConfig(branding: QtiauthConfig['branding']): Brand {
  return {
    product_name: branding.product_name,
    company_name: branding.company_name,
    support_email: branding.support_email,
    primary_color: branding.colors.primary,
  };
}

export { escapeHtml };

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

function lookup(values: Readonly<Record<string, unknown>>, path: string): string | undefined {
  let value: unknown = values;
  for (const key of path.split('.')) {
    if (typeof value !== 'object' || value === null || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function substitute(source: string, replace: (path: string) => string | undefined): string {
  return source.replace(PLACEHOLDER, (match, inner: string) => replace(inner.trim()) ?? match);
}

function checkPlaceholders(file: SourceFile, allowed: ReadonlySet<string>, template: string) {
  const issues: string[] = [];
  const at = (index: number) => `${file.path}:${String(lineOf(file.source, index))}`;
  for (const match of file.source.matchAll(PLACEHOLDER)) {
    const path = (match[1] ?? '').trim();
    if (!VARIABLE_PATH.test(path)) {
      issues.push(`${at(match.index)}: ${match[0]} isn't a variable reference like {{ link }}`);
    } else if (!allowed.has(path)) {
      issues.push(
        `${at(match.index)}: ${match[0]} isn't a variable of ${template}. It can use ${[...allowed].join(', ')}`,
      );
    }
  }
  const unclosed = file.source
    .replace(PLACEHOLDER, (match) => ' '.repeat(match.length))
    .indexOf('{{');
  if (unclosed !== -1) {
    issues.push(`${at(unclosed)}: {{ isn't closed with }}`);
  }
  return issues;
}

async function readLocaleDirs(dir: string, issues: string[]): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => !entry.name.startsWith('.'))
      .sort((a, b) => (a.name < b.name ? -1 : 1))
      .flatMap((entry) => {
        if (entry.isDirectory() && isCanonicalLocale(entry.name)) return [entry.name];
        issues.push(
          `${join(dir, entry.name)}: must be a directory named after a locale, like en-GB`,
        );
        return [];
      });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function collectFiles(
  options: LoadTemplatesOptions,
  issues: string[],
): Promise<Map<string, Map<string, Partial<Record<TemplatePart, SourceFile>>>>> {
  const byLocale = new Map<string, Map<string, Partial<Record<TemplatePart, SourceFile>>>>();
  const names = Object.keys(options.definitions);

  for (const dir of options.dirs) {
    for (const locale of await readLocaleDirs(dir, issues)) {
      const localeDir = join(dir, locale);
      const files = (await readdir(localeDir)).filter((file) => !file.startsWith('.')).sort();
      for (const file of files) {
        const path = join(localeDir, file);
        const match = TEMPLATE_FILE.exec(file);
        const [, name = '', suffix = ''] = match ?? [];
        if (!match) {
          issues.push(
            `${path}: must be named <template>.mjml, <template>.txt or <template>.subject.txt`,
          );
          continue;
        }
        if (!(name in options.definitions)) {
          issues.push(`${path}: there's no template named ${name}. Templates: ${names.join(', ')}`);
          continue;
        }
        const part = TEMPLATE_PARTS.find((p) => PART_SUFFIXES[p] === suffix) ?? 'text';
        const templates =
          byLocale.get(locale) ?? new Map<string, Partial<Record<TemplatePart, SourceFile>>>();
        byLocale.set(locale, templates);
        const parts = templates.get(name) ?? {};
        templates.set(name, parts);
        parts[part] = { path, source: await readFile(path, 'utf8') };
      }
    }
  }
  return byLocale;
}

async function compileHtml(file: SourceFile, issues: string[]): Promise<string | undefined> {
  try {
    const result = await mjml2html(file.source, {
      validationLevel: 'strict',
      filePath: file.path,
      ignoreIncludes: true,
      keepComments: false,
    });
    return result.html;
  } catch (error) {
    const errors = (error as { errors?: { line?: number; message: string }[] }).errors;
    if (!errors) {
      issues.push(`${file.path}: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
    for (const { line, message } of errors) {
      issues.push(`${file.path}${line === undefined ? '' : `:${String(line)}`}: ${message}`);
    }
    return undefined;
  }
}

export async function loadTemplates(options: LoadTemplatesOptions): Promise<TemplateSet> {
  const issues: string[] = [];
  const files = await collectFiles(options, issues);
  const brand = { brand: options.brand };
  const brandValue = (path: string) => lookup(brand, path);

  if (!files.has(options.defaultLocale)) {
    issues.push(`There are no templates for email.default_locale ${options.defaultLocale}`);
  }

  const compiled = new Map<string, Map<string, Compiled>>();
  for (const [name, definition] of Object.entries(options.definitions)) {
    const allowed = new Set([...BRAND_VARIABLES, ...templateVariables(name, definition)].sort());
    for (const [locale, templates] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const parts = templates.get(name);
      if (!parts) {
        if (locale === options.defaultLocale) {
          issues.push(
            `Template ${name} is missing from ${options.defaultLocale}, the default locale`,
          );
        }
        continue;
      }
      const missing = TEMPLATE_PARTS.filter((part) => !parts[part]);
      if (missing.length > 0) {
        issues.push(
          `Template ${name} in ${locale} is missing ${missing.map((part) => `${name}${PART_SUFFIXES[part]}`).join(', ')}`,
        );
        continue;
      }
      const { subject, text, html } = parts as Record<TemplatePart, SourceFile>;
      const found = [subject, text, html].flatMap((file) => checkPlaceholders(file, allowed, name));
      if (subject.source.trim().includes('\n')) {
        found.push(`${subject.path}: the subject must be one line`);
      }
      const mjml = await compileHtml(
        {
          ...html,
          source: substitute(html.source, (path) => {
            const value = brandValue(path);
            return value === undefined ? undefined : escapeHtml(value);
          }),
        },
        found,
      );
      issues.push(...found);
      if (found.length > 0 || mjml === undefined) continue;

      const byLocale = compiled.get(name) ?? new Map<string, Compiled>();
      compiled.set(name, byLocale);
      byLocale.set(locale, {
        subject: substitute(subject.source.trim(), brandValue),
        text: substitute(text.source, brandValue),
        html: mjml,
      });
    }
  }

  if (issues.length > 0) throw new TemplateError(issues);

  const resolveLocale = (template: string, locale: string): string => {
    const available = compiled.get(template);
    if (!available) throw new TemplateError([`There's no template named ${template}`]);
    if (available.has(locale)) return locale;
    const language = locale.split('-')[0] ?? locale;
    if (available.has(language)) return language;
    return options.defaultLocale;
  };

  return {
    defaultLocale: options.defaultLocale,
    locales: [...files.keys()].sort(),
    templates: [...compiled].map(([name, byLocale]) => ({
      name,
      locales: [...byLocale.keys()].sort(),
    })),
    resolveLocale,
    render: (template, requested, variables) => {
      const locale = resolveLocale(template, requested);
      const parts = compiled.get(template)?.get(locale);
      if (!parts) throw new TemplateError([`There's no template named ${template}`]);
      const value = (escape: (text: string) => string) => (path: string) => {
        const found = lookup(variables, path);
        if (found === undefined) {
          throw new TemplateError([`Template ${template} needs a value for {{ ${path} }}`]);
        }
        return escape(found);
      };
      return {
        locale,
        subject: substitute(
          parts.subject,
          value((text) => text.replace(/[\r\n]+/g, ' ')),
        ),
        text: substitute(
          parts.text,
          value((text) => text),
        ),
        html: substitute(parts.html, value(escapeHtml)),
      };
    },
  };
}
