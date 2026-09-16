import { describe, expect, it } from 'vitest';

import { interpolate, type InterpolateOptions } from './interpolate.ts';

const files: Record<string, string> = {
  '/run/secrets/db': 'hunter2\n',
  '/etc/qtiauth/key': 'relative\r\n',
};

const options: InterpolateOptions = {
  env: { SECRET: 's3cret', EMPTY: '' },
  baseDir: '/etc/qtiauth',
  readFile: (path) => {
    const contents = files[path];
    if (contents === undefined) {
      return Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    }
    return Promise.resolve(contents);
  },
};

describe('interpolate', () => {
  it('replaces env and file references in nested values', async () => {
    const result = await interpolate(
      {
        a: '${env:SECRET}',
        b: ['${file:/run/secrets/db}', 'x-${env:SECRET}-y'],
        c: { d: '${file:key}', e: 3, f: null, g: true },
      },
      options,
    );
    expect(result).toEqual({
      value: {
        a: 's3cret',
        b: ['hunter2', 'x-s3cret-y'],
        c: { d: 'relative', e: 3, f: null, g: true },
      },
      issues: [],
    });
  });

  it('allows an empty environment variable', async () => {
    expect((await interpolate('${env:EMPTY}', options)).value).toBe('');
  });

  it('keeps $${…} as a literal', async () => {
    expect((await interpolate('$${env:SECRET}', options)).value).toBe('${env:SECRET}');
  });

  it('does not interpolate keys', async () => {
    expect((await interpolate({ '${env:SECRET}': 1 }, options)).value).toEqual({
      '${env:SECRET}': 1,
    });
  });

  it('reports each problem with its path', async () => {
    const { issues } = await interpolate(
      {
        missing: '${env:NOPE}',
        list: ['ok', '${file:/nope}'],
        bad: '${ENV:SECRET}',
        name: '${env:1BAD}',
      },
      options,
    );
    expect(issues).toEqual([
      { path: ['missing'], message: 'Environment variable NOPE is not set' },
      { path: ['list', 1], message: "Can't read /nope (ENOENT)" },
      {
        path: ['bad'],
        message:
          'Unknown reference "${ENV:SECRET}". Use ${env:NAME} or ${file:/path}, or $${…} for a literal',
      },
      { path: ['name'], message: 'Invalid environment variable name "1BAD"' },
    ]);
  });
});
