import { describe, expect, it } from 'vitest';

import { collectRows, renderReference, type Schema } from './generate-config-reference.ts';

const schema: Schema = {
  type: 'object',
  properties: {
    branding: {
      description: 'Product and company branding.',
      type: 'object',
      default: {},
      properties: {
        product_name: {
          type: 'string',
          default: 'Example Account',
          description: 'Product name shown to users.',
          minLength: 1,
        },
        logo: {
          description: 'Logo path.',
          default: null,
          anyOf: [{ type: 'string' }, { type: 'null' }],
        },
      },
    },
    magic_link: {
      type: 'object',
      description: 'Magic link timings.',
      default: {},
      properties: {
        ttl: {
          type: 'string',
          default: '15m',
          pattern: '^\\d+(?:ms|s|m|h|d|w)$',
          description: 'How long a magic link is valid for.',
        },
      },
    },
    surfaces: {
      type: 'object',
      description: 'Surface bindings.',
      default: {},
      properties: {
        account: {
          type: 'object',
          description: 'Account surface.',
          default: {},
          properties: {
            hosts: {
              type: 'array',
              description: 'Hosts the surface answers on.',
              default: [],
              items: { type: 'string' },
            },
          },
        },
      },
    },
  },
};

describe('collectRows', () => {
  it('walks nested properties in order', () => {
    const paths = collectRows(schema, '').map((row) => row.path);
    expect(paths).toEqual([
      'branding',
      'branding.product_name',
      'branding.logo',
      'magic_link',
      'magic_link.ttl',
      'surfaces',
      'surfaces.account',
      'surfaces.account.hosts',
    ]);
  });

  it('recognises duration strings by pattern and by default', () => {
    const rows = collectRows(schema, '');
    const ttl = rows.find((row) => row.path === 'magic_link.ttl');
    expect(ttl?.type).toBe('duration');
    expect(ttl?.defaultText).toBe('`"15m"`');
  });

  it('joins anyOf types with pipes', () => {
    const rows = collectRows(schema, '');
    const logo = rows.find((row) => row.path === 'branding.logo');
    expect(logo?.type).toBe('string | null');
  });

  it('describes arrays as element[]', () => {
    const rows = collectRows(schema, '');
    const hosts = rows.find((row) => row.path === 'surfaces.account.hosts');
    expect(hosts?.type).toBe('string[]');
    expect(hosts?.defaultText).toBe('`[]`');
  });

  it('carries min/max constraints', () => {
    const rows = collectRows(schema, '');
    const productName = rows.find((row) => row.path === 'branding.product_name');
    expect(productName?.constraints).toBe('≥ 1 characters');
  });
});

describe('renderReference', () => {
  it('emits one section per top-level key with a settings table', () => {
    const output = renderReference(schema);
    expect(output).toContain('# Config reference');
    expect(output).toContain('## `branding`');
    expect(output).toContain('| `branding.product_name` | string | `"Example Account"`');
    expect(output).toContain('## `magic_link`');
    expect(output).toContain('| `magic_link.ttl` | duration | `"15m"`');
  });

  it('escapes pipe characters in cells', () => {
    const withPipe: Schema = {
      type: 'object',
      properties: {
        example: {
          type: 'object',
          default: {},
          description: 'Root.',
          properties: {
            value: {
              type: 'string',
              default: 'a | b',
              description: 'A | B',
            },
          },
        },
      },
    };
    expect(renderReference(withPipe)).toContain('| `"a \\| b"` | A \\| B |');
  });
});
