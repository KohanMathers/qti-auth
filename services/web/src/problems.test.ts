import { KIT_ERRORS } from '@qtiauth/service-kit';
import { describe, expect, it } from 'vitest';

import { WEB_ERRORS } from './errors.ts';
import { assertKitCoverage, CATALOGUE, CatalogueError, messageFor } from './problems.ts';

describe('problem catalogue', () => {
  it('covers every kit error code', () => {
    for (const code of Object.keys(KIT_ERRORS)) {
      expect(CATALOGUE[code]).toBeDefined();
    }
    expect(() => {
      assertKitCoverage();
    }).not.toThrow();
  });

  it('covers every web error code', () => {
    for (const code of Object.keys(WEB_ERRORS)) {
      expect(CATALOGUE[code]).toBeDefined();
    }
  });

  it('gives every entry a title and detail', () => {
    for (const [code, message] of Object.entries(CATALOGUE)) {
      expect(message.title, code).not.toBe('');
      expect(message.detail, code).not.toBe('');
    }
  });

  it('falls back to a generic message for unknown codes', () => {
    expect(messageFor(CATALOGUE, 'UNKNOWN_CODE_HERE').title).toBe('Something went wrong');
  });

  it('raises when a kit code is missing from the given catalogue', () => {
    const partial = { NOT_FOUND: CATALOGUE['NOT_FOUND'] } as typeof CATALOGUE;
    expect(() => {
      assertKitCoverage(partial);
    }).toThrow(CatalogueError);
  });

  it('stays in sync with the client-side JS catalogue', async () => {
    const mod = (await import('./assets/problems.js')) as { CATALOGUE: unknown };
    expect(mod.CATALOGUE).toEqual(CATALOGUE);
  });
});
