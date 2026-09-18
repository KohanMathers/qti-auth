import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { parse } from 'yaml';
import * as z from 'zod';

export const LEGAL_DOCUMENT_ID = /^[a-z][a-z0-9_-]{0,63}$/;
export const LEGAL_VERSION = /^[A-Za-z0-9._-]{1,64}$/;
export const RESERVED_LEGAL_IDS = new Set(['accept']);

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?$/;
const BRAND_PLACEHOLDER = /\{\{\s*brand\.(product_name|company_name|support_email)\s*\}\}/g;

const frontMatterSchema = z
  .object({
    id: z.string().regex(LEGAL_DOCUMENT_ID, 'Must be a document id like terms'),
    version: z.string().regex(LEGAL_VERSION, 'Must be a version like 2026-10-01'),
    effective_at: z.iso.datetime({ offset: true }),
    material: z.boolean(),
    summary: z.string().trim().min(1).max(2000),
  })
  .strict();

export class LegalDocumentsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LegalDocumentsError';
  }
}

export interface LegalBrand {
  product_name: string;
  company_name: string;
  support_email: string;
}

export interface ParsedLegalDocument {
  file: string;
  id: string;
  version: string;
  effectiveAt: Date;
  material: boolean;
  summary: string;
  body: string;
  bodyHash: string;
}

export function resolveDocumentsDir(configPath: string, documentsDir: string): string {
  return resolve(dirname(configPath), documentsDir);
}

export function hashLegalBody(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

export function interpolateLegal(text: string, brand: LegalBrand): string {
  return text.replace(BRAND_PLACEHOLDER, (_match, key: keyof LegalBrand) => brand[key]);
}

export function parseLegalDocument(file: string, source: string): ParsedLegalDocument {
  const match = FRONT_MATTER.exec(source);
  if (!match) {
    throw new LegalDocumentsError(`Legal document ${file} needs YAML front-matter`);
  }
  let raw: unknown;
  try {
    raw = parse(match[1] ?? '');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new LegalDocumentsError(
      `Legal document ${file} front-matter is not valid YAML: ${detail}`,
    );
  }
  const parsed = frontMatterSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.length ? `${issue.path.join('.')}: ` : '';
    throw new LegalDocumentsError(
      `Legal document ${file} front-matter: ${path}${issue?.message ?? 'is invalid'}`,
    );
  }
  if (RESERVED_LEGAL_IDS.has(parsed.data.id)) {
    throw new LegalDocumentsError(`Legal document ${file} id ${parsed.data.id} is reserved`);
  }
  const body = match[2] ?? '';
  if (body.trim() === '') {
    throw new LegalDocumentsError(`Legal document ${file} has an empty body`);
  }
  return {
    file,
    id: parsed.data.id,
    version: parsed.data.version,
    effectiveAt: new Date(parsed.data.effective_at),
    material: parsed.data.material,
    summary: parsed.data.summary,
    body,
    bodyHash: hashLegalBody(body),
  };
}

export async function loadLegalDocuments(dir: string): Promise<ParsedLegalDocument[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const documents: ParsedLegalDocument[] = [];
  const seen = new Map<string, string>();
  for (const name of names.sort()) {
    if (!name.endsWith('.md')) continue;
    const path = join(dir, name);
    const info = await stat(path);
    if (!info.isFile()) continue;
    const document = parseLegalDocument(name, await readFile(path, 'utf8'));
    const previous = seen.get(document.id);
    if (previous !== undefined) {
      throw new LegalDocumentsError(
        `Legal documents ${previous} and ${name} both have id ${document.id}`,
      );
    }
    seen.set(document.id, name);
    documents.push(document);
  }
  return documents;
}
