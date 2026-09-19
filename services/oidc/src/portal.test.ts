import { describe, expect, it } from 'vitest';

import { containsProductName, createClient } from './portal.ts';

const USER_ID = '0199a0e0-0000-7000-8000-000000000001';
const db = {} as never;

function create(overrides: Partial<Parameters<typeof createClient>[1]> = {}) {
  return createClient(db, {
    ownerUserId: USER_ID,
    name: 'My App',
    description: '',
    type: 'public',
    redirect_uris: ['https://app.example.com/callback'],
    require_par: false,
    backchannel_logout_uri: null,
    backchannel_logout_session_required: false,
    actor: { type: 'user', id: USER_ID },
    now: new Date(),
    productName: 'Example Account',
    maxClients: 10,
    checkText: () => Promise.resolve('allow'),
    ...overrides,
  });
}

describe('containsProductName', () => {
  it('matches the product name without regard to case', () => {
    expect(containsProductName('Example Account Games', 'Example Account')).toBe(true);
    expect(containsProductName('example account', 'Example Account')).toBe(true);
    expect(containsProductName('My App', 'Example Account')).toBe(false);
  });
});

describe('createClient', () => {
  it('rejects names that contain the product name unless later verified', async () => {
    expect(await create({ name: 'Example Account Games' })).toEqual({ status: 'name_rejected' });
  });

  it('rejects names and descriptions the text filter blocks', async () => {
    expect(await create({ checkText: () => Promise.resolve('block') })).toEqual({
      status: 'name_rejected',
    });
    expect(
      await create({
        description: 'blocked copy',
        checkText: (text) => Promise.resolve(text === 'blocked copy' ? 'block' : 'allow'),
      }),
    ).toEqual({ status: 'description_rejected' });
  });

  it('rejects invalid redirect and logout URIs before writing', async () => {
    expect(await create({ redirect_uris: ['http://example.com/callback'] })).toEqual({
      status: 'invalid_redirect',
      uri: 'http://example.com/callback',
    });
    expect(await create({ backchannel_logout_uri: 'http://example.com/logout' })).toEqual({
      status: 'invalid_logout_uri',
    });
  });

  it('fails closed when the text filter is unavailable', async () => {
    expect(await create({ checkText: () => Promise.resolve('unavailable') })).toEqual({
      status: 'unavailable',
    });
  });
});
