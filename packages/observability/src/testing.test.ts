import { describe, expect, it } from 'vitest';

import { assertLogsScrubbed, LogScrubError } from './testing.ts';

describe('assertLogsScrubbed', () => {
  it('passes when no secret appears', () => {
    expect(() => {
      assertLogsScrubbed(['{"message":"ok"}\n'], ['hunter2']);
    }).not.toThrow();
  });

  it('names the line of each leak without repeating the secret', () => {
    const lines = ['{"message":"ok"}\n', '{"password":"hunter2"}\n', '{"quote":"a\\"b-secret"}\n'];
    let error: unknown;
    try {
      assertLogsScrubbed(lines, ['hunter2', 'a"b-secret']);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(LogScrubError);
    const { message } = error as Error;
    expect(message).toContain('line 2 contains hu…r2');
    expect(message).toContain('line 3 contains a"…et');
    expect(message).not.toContain('hunter2');
  });

  it('refuses an empty secret, which would match everything', () => {
    expect(() => {
      assertLogsScrubbed([], ['']);
    }).toThrow(LogScrubError);
  });
});
