import { describe, expect, it } from 'vitest';

import { extraAuthorizeParams, REQUEST_URI_PREFIX } from './par.ts';

describe('PAR', () => {
  it('treats any authorize field other than client_id and request_uri as extra', () => {
    expect(extraAuthorizeParams({ client_id: 'game', request_uri: `${REQUEST_URI_PREFIX}x` })).toBe(
      false,
    );
    expect(
      extraAuthorizeParams({
        client_id: 'game',
        request_uri: `${REQUEST_URI_PREFIX}x`,
        redirect_uri: 'https://app.example.com/callback',
      }),
    ).toBe(true);
    expect(extraAuthorizeParams({ scope: 'openid' })).toBe(true);
  });
});
