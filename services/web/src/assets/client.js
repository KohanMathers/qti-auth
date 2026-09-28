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
    signUpPassword: (email, password, name) =>
      client.post('/auth/password/signup', { email, password, name }),
    signOut: () => client.post('/auth/logout'),
    magicLinkStart: (email) => client.post('/auth/magic-link/start', { email }),
    magicLinkVerify: (token) => client.post('/auth/magic-link/verify', { token }),
    magicLinkSignup: (token, name) => client.post('/auth/magic-link/signup', { token, name }),
    forgot: (email) => client.post('/auth/password/forgot', { email }),
    reset: (token, password) => client.post('/auth/password/reset', { token, password }),
    changePassword: (current, next) =>
      client.post('/me/password', { current_password: current, new_password: next }),
    startVerifyEmail: () => client.post('/auth/email/verify/start'),
    verifyEmail: (token) => client.post('/auth/email/verify', { token }),
    changeEmail: (email, password) => client.post('/auth/email/change', { email, password }),
    revertEmail: (token) => client.post('/auth/email/revert', { token }),
  };
}

export function me(client) {
  return {
    get: () => client.get('/me'),
    setUsername: (username) => client.put('/me/username', { username }),
    setEmail: (email) => client.put('/me/email', { email }),
    notifications: () => client.get('/me/notifications'),
    setNotifications: (preferences) => client.put('/me/notifications', { preferences }),
    legal: () => client.get('/me/legal'),
    acceptLegal: (document_id, version) =>
      client.post('/me/legal/accept', { document_id, version }),
    export: () => client.post('/me/export'),
    exportStatus: (id) => client.get(`/me/export/${encodeURIComponent(id)}`),
    deletion: () => client.get('/me/deletion'),
    requestDeletion: () => client.post('/me/deletion'),
    cancelDeletion: () => client.delete('/me/deletion'),
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
    setControls: (id, controls) =>
      client.put(`/family/${encodeURIComponent(id)}/controls`, controls),
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
  };
}

export function oauth(client) {
  return {
    authorizedApps: () => client.get('/me/oauth/apps'),
    revokeApp: (id) => client.delete(`/me/oauth/apps/${encodeURIComponent(id)}`),
    devicePair: (user_code) => client.post('/oauth/device/verify', { user_code }),
    developerClients: () => client.get('/developer/clients'),
    createClient: (spec) => client.post('/developer/clients', spec),
  };
}

export function games(client) {
  return {
    library: () => client.get('/games/library'),
    redeem: (code) => client.post('/games/keys/redeem', { code }),
    achievements: (game_id) => client.get(`/games/${encodeURIComponent(game_id)}/me/achievements`),
    stats: (game_id) => client.get(`/games/${encodeURIComponent(game_id)}/me/stats`),
    leaderboards: (game_id) => client.get(`/games/${encodeURIComponent(game_id)}/leaderboards`),
    devices: () => client.get('/games/devices'),
    revokeDevice: (id) => client.delete(`/games/devices/${encodeURIComponent(id)}`),
  };
}

export function reports(client) {
  return {
    submit: (spec) => client.post('/safety/reports', spec),
  };
}

export function admin(client) {
  return {
    users: (query = '') => client.get(`/admin/users${query}`),
    user: (id) => client.get(`/admin/users/${encodeURIComponent(id)}`),
    banUser: (id) => client.post(`/admin/users/${encodeURIComponent(id)}/ban`),
    unbanUser: (id) => client.post(`/admin/users/${encodeURIComponent(id)}/unban`),
    lockUser: (id) => client.post(`/admin/users/${encodeURIComponent(id)}/lock`),
    unlockUser: (id) => client.post(`/admin/users/${encodeURIComponent(id)}/unlock`),
    roles: () => client.get('/admin/roles'),
    audit: (query = '') => client.get(`/admin/audit${query}`),
    webhooks: () => client.get('/admin/webhooks'),
    filterBlocks: () => client.get('/admin/filter/blocks'),
    filterAllowlist: () => client.get('/admin/filter/allowlist'),
    filterBlocklist: () => client.get('/admin/filter/blocklist'),
    moderationQueue: () => client.get('/admin/moderation/queue'),
    cseaCases: () => client.get('/admin/csea/cases'),
    oauthClients: () => client.get('/admin/oauth/clients'),
    gamesCatalog: () => client.get('/admin/games'),
    health: () => client.get('/admin/health'),
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
