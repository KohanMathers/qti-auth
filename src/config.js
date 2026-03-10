export const CONFIG = {
  // Keep secrets out of source control; use env-managed secrets in production.
  JWT_SECRET: 'REPLACE_WITH_STRONG_SECRET_IN_PRODUCTION',
  SESSION_DURATION: 7 * 24 * 60 * 60,
  EMAIL_TOKEN_EXPIRY: 15 * 60,
  USERNAME_MIN_LENGTH: 8,
  USERNAME_MAX_LENGTH: 18,
  MAX_ACCOUNTS_PER_EMAIL: 2,
  USERNAME_CHANGE_COOLDOWN: 30 * 24 * 60 * 60,
  MAX_USERNAME_CHANGES_PER_YEAR: 3,
  ADMIN_PREFIX: 'QTI_',

  REPORT_REVIEW_SLA: 24 * 60 * 60,

  MAX_SESSIONS_PER_USER: 10,
  LEGACY_TOKEN_DEADLINE: 1737331200,
  SECURITY_EVENT_RATE_LIMIT: 10,
  SECURITY_ALERT_RATE_LIMIT: 3,

  GAME_LEASE_DURATION: 20 * 24 * 60 * 60, // 20 days in seconds

  OAUTH_PROVIDER: {
    AUTH_CODE_EXPIRY: 10 * 60,
    ACCESS_TOKEN_EXPIRY: 60 * 60,
    REFRESH_TOKEN_EXPIRY: 30 * 24 * 60 * 60,
    ID_TOKEN_EXPIRY: 60 * 60,
    SUPPORTED_SCOPES: ['openid', 'profile', 'email'],
    SUPPORTED_RESPONSE_TYPES: ['code'],
    SUPPORTED_GRANT_TYPES: ['authorization_code', 'refresh_token'],
    SUPPORTED_CODE_CHALLENGE_METHODS: ['S256'],
  },
};

export const REPORT_TYPES = {
  ILLEGAL_CONTENT: 'illegal_content',
  HARMFUL_TO_CHILD: 'harmful_to_child',
  HARASSMENT: 'harassment',
  HATE_SPEECH: 'hate_speech',
  THREATS: 'threats',
  SELF_HARM: 'self_harm',
  FRAUD: 'fraud',
  SPAM: 'spam',
  OTHER: 'other',
};

export const REPORT_SUBTYPES = {
  CSAM: 'csam',
  TERRORISM: 'terrorism',
  EXTREME_VIOLENCE: 'extreme_violence',

  STALKING: 'stalking',
  THREATENING_COMMS: 'threatening_communications',
  INCITING_VIOLENCE: 'inciting_violence',

  RACIAL_HATRED: 'racial_hatred',
  RELIGIOUS_HATRED: 'religious_hatred',
  HOMOPHOBIC_HATRED: 'homophobic_hatred',

  SUICIDE_PROMOTION: 'suicide_promotion',
  SELF_HARM_PROMOTION: 'self_harm_promotion',
  EATING_DISORDER: 'eating_disorder',

  GROOMING: 'grooming',
  INAPPROPRIATE_CONTACT: 'inappropriate_contact',
  CHILD_ENDANGERMENT: 'child_endangerment',
};

export const RATE_LIMITS = {
  // Keep these conservative; adjust once telemetry proves it's safe.
  EMAIL_REQUESTS_PER_HOUR: 3,
  EMAIL_REQUESTS_PER_IP_HOUR: 10,
  EMAIL_REQUESTS_PER_IP_DAY: 20,
  GLOBAL_REQUESTS_PER_MINUTE: 100,
};
