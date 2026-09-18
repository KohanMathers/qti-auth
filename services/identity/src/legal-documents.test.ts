import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  hashLegalBody,
  interpolateLegal,
  LegalDocumentsError,
  loadLegalDocuments,
  parseLegalDocument,
} from './legal-documents.ts';

const brand = {
  product_name: 'Example Account',
  company_name: 'Example Ltd',
  support_email: 'support@example.com',
};

function source(overrides: string[] = []): string {
  return `---
id: terms
version: 2026-10-01
effective_at: 2026-10-01T00:00:00Z
material: true
summary: "We added passkeys."
${overrides.join('\n')}
---

# Terms

These terms apply to {{ brand.product_name }}.
`;
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'qtiauth-legal-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('parseLegalDocument', () => {
  it('reads front-matter and hashes the body, not the interpolated text', () => {
    const document = parseLegalDocument('terms.md', source());
    expect(document).toMatchObject({
      id: 'terms',
      version: '2026-10-01',
      material: true,
      summary: 'We added passkeys.',
    });
    expect(document.effectiveAt.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(document.body).toContain('{{ brand.product_name }}');
    expect(document.bodyHash).toBe(hashLegalBody(document.body));
    expect(document.bodyHash).not.toBe(hashLegalBody(interpolateLegal(document.body, brand)));
  });

  it('rejects a missing or empty body, a reserved id, and invalid front-matter', () => {
    expect(() => parseLegalDocument('terms.md', 'no front matter')).toThrow(LegalDocumentsError);
    expect(() =>
      parseLegalDocument('terms.md', source().replace('id: terms', 'id: accept')),
    ).toThrow(/reserved/);
    expect(() =>
      parseLegalDocument(
        'terms.md',
        `---
id: terms
version: 2026-10-01
effective_at: 2026-10-01T00:00:00Z
material: true
summary: "x"
---
`,
      ),
    ).toThrow(/empty body/);
    expect(() => parseLegalDocument('terms.md', source(['extra: true']))).toThrow(
      LegalDocumentsError,
    );
  });
});

describe('interpolateLegal', () => {
  it('fills brand placeholders', () => {
    expect(interpolateLegal('Operated by {{ brand.company_name }}.', brand)).toBe(
      'Operated by Example Ltd.',
    );
  });
});

describe('loadLegalDocuments', () => {
  it('returns nothing when the directory is missing', async () => {
    expect(await loadLegalDocuments(join(dir, 'missing'))).toEqual([]);
  });

  it('loads markdown files and rejects two files with the same id', async () => {
    await writeFile(join(dir, 'terms.md'), source());
    await writeFile(
      join(dir, 'privacy.md'),
      source()
        .replace('id: terms', 'id: privacy')
        .replace('version: 2026-10-01', 'version: 2026-10-02'),
    );
    const documents = await loadLegalDocuments(dir);
    expect(documents.map((document) => document.id).sort()).toEqual(['privacy', 'terms']);

    await writeFile(join(dir, 'also.md'), source());
    await expect(loadLegalDocuments(dir)).rejects.toThrow(/both have id terms/);
  });
});
