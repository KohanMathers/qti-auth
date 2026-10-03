export class ProblemFetchError extends Error {
  constructor(problem) {
    super(problem.title ?? 'Request failed');
    this.name = 'ProblemFetchError';
    this.problem = problem;
  }
}

export function apiClient(bootstrap, fetcher = window.fetch.bind(window)) {
  const base = bootstrap.metaOrigin ?? '';
  const prefix = base === '' ? bootstrap.basePath.replace(/\/$/, '') : base;
  const request = async (method, path, body) => {
    const url = `${prefix}/api/v1${path}`;
    const init = {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    };
    const response = await fetcher(url, init);
    if (response.status === 204) return null;
    const contentType = response.headers.get('content-type') ?? '';
    if (!response.ok) {
      if (contentType.includes('application/problem+json')) {
        throw new ProblemFetchError(await response.json());
      }
      throw new ProblemFetchError({
        code: 'INTERNAL_ERROR',
        status: response.status,
        title: 'Request failed',
      });
    }
    if (contentType.includes('application/json')) return response.json();
    return null;
  };
  return {
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body ?? {}),
    put: (path, body) => request('PUT', path, body ?? {}),
    patch: (path, body) => request('PATCH', path, body ?? {}),
    delete: (path) => request('DELETE', path),
  };
}

export function auth(client) {
  return {
    signInPassword: (email, password) => client.post('/auth/password/login', { email, password }),
    secondFactor: (challenge, factor) => client.post('/auth/2fa', { challenge, ...factor }),
    passkeyStart: (second_factor) =>
      client.post('/auth/passkey/authenticate/start', { second_factor }),
    passkeyFinish: (challenge, response) =>
      client.post('/auth/passkey/authenticate', { challenge, response }),
    signUpPassword: (spec) => client.post('/auth/password/signup', spec),
    signOut: () => client.post('/auth/logout'),
    magicLinkStart: (email, return_to) =>
      client.post('/auth/magic-link/start', { email, return_to }),
    magicLinkVerify: (token, user_id) => client.post('/auth/magic-link/verify', { token, user_id }),
    magicLinkSignup: (spec) => client.post('/auth/magic-link/signup', spec),
    socialStart: (provider, return_to) =>
      client.post(`/auth/social/${encodeURIComponent(provider)}/start`, { return_to }),
    socialComplete: (spec) => client.post('/auth/social/complete', spec),
    socialSignup: (spec) => client.post('/auth/social/signup', spec),
    forgot: (email) => client.post('/auth/password/forgot', { email }),
    reset: (token, password, extra = {}) =>
      client.post('/auth/password/reset', { token, password, ...extra }),
    setPassword: (password, current_password) =>
      client.post('/me/password', { password, current_password }),
    startVerifyEmail: (email) => client.post('/auth/email/verify/start', { email }),
    verifyEmail: (token) => client.post('/auth/email/verify', { token }),
    confirmEmailChange: (token) => client.post('/auth/email/change', { token }),
    revertEmail: (token) => client.post('/auth/email/revert', { token }),
    guardianApprove: (token, date_of_birth) =>
      client.post('/auth/parental-consent/approve', { token, date_of_birth }),
    guardianDecline: (token) => client.post('/auth/parental-consent/decline', { token }),
  };
}

export function me(client) {
  return {
    get: () => client.get('/me'),
    setUsername: (username) => client.post('/me/username', { username }),
    setEmail: (email) => client.post('/me/email', { email }),
    notifications: () => client.get('/me/notifications'),
    setNotifications: (categories) => client.patch('/me/notifications', { categories }),
    legal: () => client.get('/me/legal'),
    legalDocument: (id) => client.get(`/legal/${encodeURIComponent(id)}`),
    acceptLegal: (documents) => client.post('/me/legal/accept', { documents }),
    export: () => client.post('/me/export'),
    exportStatus: (id) => client.get(`/me/export/${encodeURIComponent(id)}`),
    requestDeletion: () => client.post('/me/deletion'),
    requestFamilyRemoval: () => client.post('/me/family/removal'),
    cancelFamilyRemoval: () => client.delete('/me/family/removal'),
  };
}

export function factors(client) {
  const passkey = (id) => `/me/passkeys/${encodeURIComponent(id)}`;
  return {
    list: () => client.get('/me/factors'),
    totpStart: () => client.post('/me/totp/start'),
    totpConfirm: (challenge, code) => client.post('/me/totp', { challenge, code }),
    totpDisable: (code) => client.post('/me/totp/disable', { code }),
    recoveryCodes: () => client.post('/me/recovery-codes'),
    passkeyRegisterStart: () => client.post('/me/passkeys/register/start'),
    passkeyRegister: (challenge, name, response) =>
      client.post('/me/passkeys/register', { challenge, name, response }),
    renamePasskey: (id, name) => client.post(passkey(id), { name }),
    removePasskey: (id) => client.delete(passkey(id)),
    stepUp: (factor) => client.post('/me/step-up', factor),
    stepUpPasskeyStart: () => client.post('/me/step-up/passkey/start'),
    stepUpPasskey: (challenge, response) =>
      client.post('/me/step-up/passkey', { challenge, response }),
  };
}

export function sessions(client) {
  return {
    list: () => client.get('/sessions'),
    revoke: (id) => client.delete(`/sessions/${encodeURIComponent(id)}`),
    revokeOthers: () => client.post('/sessions/revoke-others'),
    revokeAll: () => client.post('/sessions/revoke-all'),
  };
}

export function family(client) {
  return {
    list: () => client.get('/family'),
    child: (id) => client.get(`/family/${encodeURIComponent(id)}`),
    openSession: (token) => client.post('/auth/family/session', { token }),
    acceptInvite: (token, date_of_birth) =>
      client.post('/auth/family/invite/accept', { token, date_of_birth }),
    requestSessionEmail: (email) => client.post('/auth/family/magic-link', { email }),
    logout: () => client.post('/auth/family/logout'),
    setControls: (id, controls) =>
      client.patch(`/family/${encodeURIComponent(id)}/controls`, controls),
    childSessions: (id) => client.get(`/family/${encodeURIComponent(id)}/sessions`),
    revokeChildSession: (id, sessionId) =>
      client.delete(`/family/${encodeURIComponent(id)}/sessions/${encodeURIComponent(sessionId)}`),
    revokeAllChildSessions: (id) =>
      client.post(`/family/${encodeURIComponent(id)}/sessions/revoke-all`),
    approveUsername: (id, requestId) =>
      client.post(
        `/family/${encodeURIComponent(id)}/username-changes/${encodeURIComponent(requestId)}/approve`,
      ),
    declineUsername: (id, requestId) =>
      client.post(
        `/family/${encodeURIComponent(id)}/username-changes/${encodeURIComponent(requestId)}/decline`,
      ),
    approveApp: (id, requestId) =>
      client.post(
        `/family/${encodeURIComponent(id)}/app-approvals/${encodeURIComponent(requestId)}/approve`,
      ),
    declineApp: (id, requestId) =>
      client.post(
        `/family/${encodeURIComponent(id)}/app-approvals/${encodeURIComponent(requestId)}/decline`,
      ),
    activity: (id) => client.get(`/family/${encodeURIComponent(id)}/activity`),
    approveRemoval: (id) => client.post(`/family/${encodeURIComponent(id)}/removal/approve`),
    declineRemoval: (id) => client.post(`/family/${encodeURIComponent(id)}/removal/decline`),
  };
}

export function oauth(client) {
  return {
    authorizedApps: () => client.get('/oauth/authorized'),
    revokeApp: (clientId) => client.delete(`/oauth/authorized/${encodeURIComponent(clientId)}`),
    consentRequest: (request_id) =>
      client.get(`/oauth/consent?${new URLSearchParams({ request_id }).toString()}`),
    decideConsent: (request_id, decision) =>
      client.post('/oauth/consent', { request_id, decision }),
    deviceRequest: (user_code) =>
      client.get(`/oauth/device?${new URLSearchParams({ user_code }).toString()}`),
    decideDevice: (user_code, decision) =>
      client.post('/oauth/device/verify', { user_code, decision }),
    developerClients: () => client.get('/oauth/clients'),
    createClient: (spec) => client.post('/oauth/clients', spec),
  };
}

export function games(client) {
  const game = (slug) => `/games/${encodeURIComponent(slug)}`;
  return {
    owned: () => client.get('/games/owned'),
    redeem: (code) => client.post('/games/keys/redeem', { code }),
    achievements: (slug) => client.get(`${game(slug)}/achievements`),
    stats: (slug) => client.get(`${game(slug)}/stats/values`),
    leaderboard: (slug, stat, board) =>
      client.get(
        `${game(slug)}/leaderboards/${encodeURIComponent(stat)}/${encodeURIComponent(board)}`,
      ),
    devices: (slug) => client.get(`${game(slug)}/licensing/devices`),
    revokeDevice: (slug, leaseId) =>
      client.delete(`${game(slug)}/licensing/devices/${encodeURIComponent(leaseId)}`),
  };
}

export function reports(client) {
  return {
    taxonomy: () => client.get('/safety/taxonomy'),
    submit: (spec) => client.post('/safety/reports', spec),
  };
}

export function admin(client) {
  const user = (id) => `/admin/users/${encodeURIComponent(id)}`;
  const oauthClient = (id) => `/admin/oauth/clients/${encodeURIComponent(id)}`;
  const webhook = (id) => `/admin/webhooks/${encodeURIComponent(id)}`;
  const report = (id) => `/admin/safety/reports/${encodeURIComponent(id)}`;
  const cseaCase = (id) => `/admin/safety/csea/cases/${encodeURIComponent(id)}`;
  const entitlement = (id) => `/admin/entitlements/${encodeURIComponent(id)}`;
  return {
    users: (query = '') => client.get(`/admin/users${query}`),
    user: (id) => client.get(user(id)),
    banUser: (id, reason) => client.post(`${user(id)}/ban`, { reason }),
    unbanUser: (id, reason) => client.post(`${user(id)}/unban`, { reason }),
    lockUser: (id, reason, expires_at) => client.post(`${user(id)}/lock`, { reason, expires_at }),
    unlockUser: (id, reason) => client.post(`${user(id)}/unlock`, { reason }),
    forceReauth: (id, reason) => client.post(`${user(id)}/reauth`, { reason }),
    revokeUserSessions: (id, reason) => client.post(`${user(id)}/sessions/revoke`, { reason }),
    resetUsername: (id, reason) => client.post(`${user(id)}/username-reset`, { reason }),
    roles: () => client.get('/admin/roles'),
    audit: (query = '') => client.get(`/admin/audit${query}`),
    webhooks: () => client.get('/admin/webhooks'),
    webhook: (id) => client.get(webhook(id)),
    webhookDeliveries: (id) => client.get(`${webhook(id)}/deliveries`),
    setWebhookEnabled: (id, enabled) => client.patch(webhook(id), { enabled }),
    testWebhook: (id) => client.post(`${webhook(id)}/test`),
    filterBlocks: () => client.get('/admin/filter/blocks'),
    filterAllowlist: () => client.get('/admin/filter/allowlist'),
    filterBlocklist: () => client.get('/admin/filter/blocklist'),
    moderationQueue: () => client.get('/admin/safety/reports?status=open'),
    report: (id) => client.get(report(id)),
    reportAction: (id, spec) => client.post(`${report(id)}/actions`, spec),
    dismissReport: (id) => client.post(`${report(id)}/dismiss`),
    safetyCatalog: () => client.get('/admin/safety/catalog'),
    appeals: () => client.get('/admin/safety/appeals?status=open'),
    resolveAppeal: (id, outcome) =>
      client.post(`/admin/safety/appeals/${encodeURIComponent(id)}/resolve`, { outcome }),
    cseaCases: () => client.get('/admin/safety/csea/cases'),
    cseaCase: (id) => client.get(cseaCase(id)),
    protectCseaCase: (id) => client.post(`${cseaCase(id)}/protect`),
    submitCseaCase: (id, spec) => client.post(`${cseaCase(id)}/submit`, spec),
    closeCseaCase: (id, reason) => client.post(`${cseaCase(id)}/close`, { reason }),
    oauthClients: (query = '') => client.get(`/admin/oauth/clients${query}`),
    oauthClient: (id) => client.get(oauthClient(id)),
    verifyOauthClient: (id) => client.post(`${oauthClient(id)}/verify`),
    suspendOauthClient: (id) => client.post(`${oauthClient(id)}/suspend`),
    unsuspendOauthClient: (id) => client.post(`${oauthClient(id)}/unsuspend`),
    gamesCatalog: () => client.get('/admin/games'),
    userEntitlements: (userId) =>
      client.get(`/admin/entitlements?${new URLSearchParams({ user_id: userId }).toString()}`),
    entitlement: (id) => client.get(entitlement(id)),
    revokeEntitlement: (id, reason) => client.post(`${entitlement(id)}/revoke`, { reason }),
    health: () => client.get('/meta/health'),
  };
}

export function support(client) {
  return {
    categories: () => client.get('/support/categories'),
    listTickets: () => client.get('/support/tickets'),
    getTicket: (id) => client.get(`/support/tickets/${encodeURIComponent(id)}`),
    createTicket: (spec) => client.post('/support/tickets', spec),
    reply: (id, body) =>
      client.post(`/support/tickets/${encodeURIComponent(id)}/replies`, { body }),
    close: (id) => client.post(`/support/tickets/${encodeURIComponent(id)}/close`),
    reopen: (id) => client.post(`/support/tickets/${encodeURIComponent(id)}/reopen`),
    rate: (id, rating) =>
      client.post(`/support/tickets/${encodeURIComponent(id)}/rate`, { rating }),
    createAppeal: (spec) => client.post('/support/appeals', spec),
    addAttachment: (id, spec) =>
      client.post(`/support/tickets/${encodeURIComponent(id)}/attachments`, spec),
    downloadAttachment: (ticketId, attachmentId) =>
      client.post(
        `/support/tickets/${encodeURIComponent(ticketId)}/attachments/${encodeURIComponent(attachmentId)}/download`,
      ),
  };
}

export function guestSupport(client) {
  return {
    categories: () => client.get('/support/guest/categories'),
    captcha: () => client.get('/support/guest/captcha'),
    requestCode: (email, captcha) => client.post('/support/guest/codes', { email, captcha }),
    createTicket: (spec) => client.post('/support/guest/tickets', spec),
    viewTicket: (token) => client.post('/support/guest/tickets/view', { token }),
    reply: (token, body) => client.post('/support/guest/tickets/replies', { token, body }),
    close: (token) => client.post('/support/guest/tickets/close', { token }),
    reopen: (token) => client.post('/support/guest/tickets/reopen', { token }),
    rate: (token, rating) => client.post('/support/guest/tickets/rate', { token, rating }),
    addAttachment: (token, spec) => client.post('/support/guest/attachments', { token, ...spec }),
    downloadAttachment: (token, attachment_id) =>
      client.post('/support/guest/attachments/download', { token, attachment_id }),
  };
}

export function kb(client) {
  return {
    categories: () => client.get('/support/kb/categories'),
    category: (slug) => client.get(`/support/kb/categories/${encodeURIComponent(slug)}`),
    articles: (categorySlug) =>
      client.get(
        categorySlug === undefined
          ? '/support/kb/articles'
          : `/support/kb/articles?category=${encodeURIComponent(categorySlug)}`,
      ),
    article: (slug) => client.get(`/support/kb/articles/${encodeURIComponent(slug)}`),
    search: (q) => client.get(`/support/kb/search?q=${encodeURIComponent(q)}`),
    related: (subject) => client.get(`/support/kb/related?subject=${encodeURIComponent(subject)}`),
    feedback: (slug, helpful) =>
      client.post(`/support/kb/articles/${encodeURIComponent(slug)}/feedback`, { helpful }),
  };
}

export function staffSupport(client) {
  return {
    tickets: (query = '') => client.get(`/admin/support/tickets${query}`),
    ticket: (id) => client.get(`/admin/support/tickets/${encodeURIComponent(id)}`),
    reply: (id, spec) =>
      client.post(`/admin/support/tickets/${encodeURIComponent(id)}/replies`, spec),
    addNote: (id, body) =>
      client.post(`/admin/support/tickets/${encodeURIComponent(id)}/notes`, { body }),
    update: (id, patch) => client.patch(`/admin/support/tickets/${encodeURIComponent(id)}`, patch),
    close: (id) => client.post(`/admin/support/tickets/${encodeURIComponent(id)}/close`),
    reopen: (id) => client.post(`/admin/support/tickets/${encodeURIComponent(id)}/reopen`),
    macros: () => client.get('/admin/support/macros'),
    createMacro: (spec) => client.post('/admin/support/macros', spec),
    updateMacro: (id, patch) =>
      client.patch(`/admin/support/macros/${encodeURIComponent(id)}`, patch),
    deleteMacro: (id) => client.delete(`/admin/support/macros/${encodeURIComponent(id)}`),
    metrics: (sinceDays) =>
      client.get(
        sinceDays === undefined
          ? '/admin/support/metrics'
          : `/admin/support/metrics?since_days=${encodeURIComponent(sinceDays)}`,
      ),
  };
}

export function staffKb(client) {
  return {
    categories: () => client.get('/admin/support/kb/categories'),
    createCategory: (spec) => client.post('/admin/support/kb/categories', spec),
    updateCategory: (id, patch) =>
      client.patch(`/admin/support/kb/categories/${encodeURIComponent(id)}`, patch),
    deleteCategory: (id) => client.delete(`/admin/support/kb/categories/${encodeURIComponent(id)}`),
    articles: (query = '') => client.get(`/admin/support/kb/articles${query}`),
    article: (id) => client.get(`/admin/support/kb/articles/${encodeURIComponent(id)}`),
    createArticle: (spec) => client.post('/admin/support/kb/articles', spec),
    updateArticle: (id, patch) =>
      client.patch(`/admin/support/kb/articles/${encodeURIComponent(id)}`, patch),
    deleteArticle: (id) => client.delete(`/admin/support/kb/articles/${encodeURIComponent(id)}`),
    revisions: (id) => client.get(`/admin/support/kb/articles/${encodeURIComponent(id)}/revisions`),
    revision: (id, revision) =>
      client.get(
        `/admin/support/kb/articles/${encodeURIComponent(id)}/revisions/${encodeURIComponent(revision)}`,
      ),
    diff: (id, revision, against) =>
      client.get(
        against === undefined
          ? `/admin/support/kb/articles/${encodeURIComponent(id)}/revisions/${encodeURIComponent(revision)}/diff`
          : `/admin/support/kb/articles/${encodeURIComponent(id)}/revisions/${encodeURIComponent(revision)}/diff?against=${encodeURIComponent(against)}`,
      ),
    restore: (id, revision) =>
      client.post(
        `/admin/support/kb/articles/${encodeURIComponent(id)}/revisions/${encodeURIComponent(revision)}/restore`,
      ),
  };
}
