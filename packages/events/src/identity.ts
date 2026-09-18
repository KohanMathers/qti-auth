export const IDENTITY_EVENTS = {
  userCreated: 'qtiauth.identity.user.created.v1',
  userUpdated: 'qtiauth.identity.user.updated.v1',
  userDeleted: 'qtiauth.identity.user.deleted.v1',
  userBanned: 'qtiauth.identity.user.banned.v1',
  userUnbanned: 'qtiauth.identity.user.unbanned.v1',
  userLocked: 'qtiauth.identity.user.locked.v1',
  userUnlocked: 'qtiauth.identity.user.unlocked.v1',
  userRestricted: 'qtiauth.identity.user.restricted.v1',
  userAgeBandChanged: 'qtiauth.identity.user.age_band_changed.v1',
  sessionCreated: 'qtiauth.identity.session.created.v1',
  sessionRevoked: 'qtiauth.identity.session.revoked.v1',
  sessionFlagged: 'qtiauth.identity.session.flagged.v1',
  parentalConsentRequested: 'qtiauth.identity.parental.consent_requested.v1',
  parentalConsentGranted: 'qtiauth.identity.parental.consent_granted.v1',
  parentalConsentRevoked: 'qtiauth.identity.parental.consent_revoked.v1',
  legalVersionPublished: 'qtiauth.identity.legal.version_published.v1',
} as const;

export type IdentityEventType = (typeof IDENTITY_EVENTS)[keyof typeof IDENTITY_EVENTS];
