import { describe, expect, it } from 'vitest';

import { countryName, describePlace, deviceKey, parseDevice } from './device.ts';

describe('parseDevice', () => {
  it('names common browsers and operating systems', () => {
    expect(
      parseDevice(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      ),
    ).toEqual({ browser: 'Chrome', os: 'Windows' });
    expect(
      parseDevice(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
      ),
    ).toEqual({ browser: 'Safari', os: 'macOS' });
    expect(
      parseDevice(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0',
      ),
    ).toEqual({ browser: 'Edge', os: 'Windows' });
    expect(parseDevice(null)).toEqual({
      browser: 'an unknown browser',
      os: 'an unknown OS',
    });
  });
});

describe('deviceKey', () => {
  it('is stable for the same browser and OS', () => {
    expect(deviceKey({ browser: 'Chrome', os: 'Windows' })).toBe('Chrome|Windows');
  });
});

describe('describePlace', () => {
  it('uses the English country name', () => {
    expect(describePlace('GB')).toBe(`in ${countryName('GB') ?? 'GB'}`);
    expect(describePlace(null)).toBe('from an unknown location');
  });
});
