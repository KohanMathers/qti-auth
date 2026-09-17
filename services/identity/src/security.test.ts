import { describe, expect, it } from 'vitest';

import { evaluateSecurity } from './security.ts';
import type { TrustSignals } from './trust.ts';

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

describe('evaluateSecurity', () => {
  it('drops a session to aal0 when the country changes under challenge', () => {
    expect(evaluateSecurity(signals(), signals({ country: 'US' }), 'aal1', 'challenge')).toEqual({
      trust: 'challenge',
      acr: 'aal0',
      action: 'challenge',
      countryChanged: true,
      reason: 'country_change',
    });
  });

  it('blocks when the country-change policy is block', () => {
    expect(evaluateSecurity(signals(), signals({ country: 'US' }), 'aal1', 'block')).toMatchObject({
      trust: 'blocked',
      action: 'block',
      reason: 'country_change',
    });
  });

  it('leaves an already-challenged session at aal0', () => {
    expect(evaluateSecurity(signals(), signals(), 'aal0', 'challenge')).toMatchObject({
      acr: 'aal0',
      action: 'none',
    });
  });

  it('ignores a country change when the policy is ignore', () => {
    expect(evaluateSecurity(signals(), signals({ country: 'US' }), 'aal1', 'ignore')).toMatchObject(
      {
        acr: 'aal1',
        action: 'none',
        countryChanged: true,
      },
    );
  });
});
