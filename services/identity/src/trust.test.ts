import { describe, expect, it } from 'vitest';

import { trustLevelForScore, trustScore, worseTrust, type TrustSignals } from './trust.ts';

function signals(overrides: Partial<TrustSignals> = {}): TrustSignals {
  return {
    ip: '203.0.113.10',
    subnet: '203.0.113.0/24',
    country: 'GB',
    userAgent: 'Firefox',
    tlsFingerprint: null,
    timezone: null,
    screen: null,
    clientFingerprint: null,
    ...overrides,
  };
}

describe('trustScore', () => {
  it('is full when the same client comes back', () => {
    expect(trustScore(signals(), signals())).toBe(100);
    expect(trustLevelForScore(100)).toBe('full');
  });

  it('stays partial for a new IP in the same country and subnet', () => {
    const score = trustScore(signals(), signals({ ip: '203.0.113.20' }));
    expect(trustLevelForScore(score)).toBe('partial');
  });

  it('is low when the country and network both change', () => {
    const score = trustScore(
      signals(),
      signals({ ip: '198.51.100.2', subnet: '198.51.100.0/24', country: 'US' }),
    );
    expect(score).toBeLessThan(25);
    expect(trustLevelForScore(score)).toBe('blocked');
  });

  it('ignores signals that were never captured', () => {
    expect(trustScore(signals({ tlsFingerprint: null }), signals({ tlsFingerprint: 'abc' }))).toBe(
      100,
    );
  });
});

describe('worseTrust', () => {
  it('moves only towards blocked', () => {
    expect(worseTrust('full', 'partial')).toBe('partial');
    expect(worseTrust('challenge', 'partial')).toBe('challenge');
    expect(worseTrust('blocked', 'full')).toBe('blocked');
  });
});
