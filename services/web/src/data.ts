import type { QtiauthConfig } from '@qtiauth/config';

import { type GatewayClient, gatewayClient } from './gateway-client.ts';

export type PageParams = Record<string, string>;

export interface LoadContext {
  request: Request;
  config: Pick<QtiauthConfig, 'cookies' | 'branding' | 'surfaces'>;
  params: PageParams;
  gateway: GatewayClient;
  query: URLSearchParams;
}

export type PageData = Record<string, unknown>;

export type Loader = (ctx: LoadContext) => Promise<PageData>;

function get(obj: unknown, key: string): unknown {
  if (obj === null || typeof obj !== 'object') return undefined;
  return (obj as Record<string, unknown>)[key];
}

function str(value: unknown, fallback = ''): string {
  if (value === null || value === undefined) return fallback;
  return String(value);
}

function itemsOf(data: unknown): unknown[] {
  const items = get(data, 'items');
  return Array.isArray(items) ? items : [];
}

function localDate(value: unknown): string {
  if (value === null || value === undefined) return '';
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString().slice(0, 10);
}

function identityData(ctx: LoadContext): PageData {
  return {
    product_name: ctx.config.branding.product_name,
    company_name: ctx.config.branding.company_name,
  };
}

function loadBranding(ctx: LoadContext): Promise<PageData> {
  return Promise.resolve(identityData(ctx));
}

function socialProviders(data: unknown): { id: string; name: string }[] {
  const raw = get(get(data, 'auth'), 'social');
  return Array.isArray(raw)
    ? raw.map((provider: unknown) => ({ id: str(get(provider, 'id')), name: str(get(provider, 'name')) }))
    : [];
}

async function loadAuthMethods(ctx: LoadContext): Promise<Record<string, unknown>> {
  const data = await ctx.gateway.get<Record<string, unknown>>('/api/v1/meta/features');
  const methods = get(get(data, 'auth'), 'methods');
  return {
    password: Boolean(get(methods, 'password')),
    magic_link: Boolean(get(methods, 'magic_link')),
    passkeys: Boolean(get(methods, 'passkeys')),
    social: socialProviders(data),
  };
}

async function loadSignIn(ctx: LoadContext): Promise<PageData> {
  return { ...identityData(ctx), ...(await loadAuthMethods(ctx)) };
}

async function loadSignUp(ctx: LoadContext): Promise<PageData> {
  const { password, magic_link } = await loadAuthMethods(ctx);
  return {
    ...identityData(ctx),
    password,
    magic_only: Boolean(magic_link) && !password,
  };
}

async function loadAccount(ctx: LoadContext): Promise<PageData> {
  const me = await ctx.gateway.get<Record<string, unknown>>('/api/v1/me');
  const username = str(get(me, 'username'));
  return {
    ...identityData(ctx),
    username,
    email: str(get(me, 'email')),
    initials: username.length > 0 ? username.slice(0, 1).toUpperCase() : '',
  };
}

async function loadProfile(ctx: LoadContext): Promise<PageData> {
  const me = await ctx.gateway.get<Record<string, unknown>>('/api/v1/me');
  return {
    ...identityData(ctx),
    username: str(get(me, 'username')),
    email: str(get(me, 'email')),
    profile_state: me === null ? 'error' : 'ready',
  };
}

async function loadSessions(ctx: LoadContext): Promise<PageData> {
  const data = await ctx.gateway.get<Record<string, unknown>>('/api/v1/sessions');
  const items = itemsOf(data).map((item) => {
    const device = get(item, 'device');
    return {
      id: get(item, 'id'),
      device: `${str(get(device, 'browser'))} · ${str(get(device, 'os'))}`,
      country: str(get(item, 'country')),
      last_active: localDate(get(item, 'last_active_at')),
      current: Boolean(get(item, 'current')),
      not_current: !get(item, 'current'),
    };
  });
  return {
    ...identityData(ctx),
    sessions: items,
    sessions_state: data === null ? 'error' : items.length === 0 ? 'empty' : 'list',
  };
}

async function loadFamily(ctx: LoadContext): Promise<PageData> {
  const data = await ctx.gateway.get<Record<string, unknown>>('/api/v1/family');
  const raw = get(data, 'children');
  const children = Array.isArray(raw)
    ? raw.map((child: unknown) => ({
        id: get(child, 'id'),
        name: str(get(child, 'username'), str(get(child, 'id'))),
        path: `/family/${encodeURIComponent(str(get(child, 'id')))}`,
      }))
    : [];
  return {
    ...identityData(ctx),
    children,
    children_state: data === null ? 'error' : children.length === 0 ? 'empty' : 'list',
  };
}

async function loadNotifications(ctx: LoadContext): Promise<PageData> {
  const data = await ctx.gateway.get<Record<string, unknown>>('/api/v1/me/notifications');
  const raw = get(data, 'categories');
  const channels = Array.isArray(raw)
    ? raw.map((category: unknown) => ({
        id: `qtiauth-p-${str(get(category, 'id'))}`,
        channel: get(category, 'id'),
        enabled: get(category, 'enabled'),
        locked: !get(category, 'disableable'),
        label: str(get(category, 'description')),
      }))
    : [];
  return {
    ...identityData(ctx),
    channels,
    channels_state: data === null ? 'error' : 'list',
  };
}

async function loadLegal(ctx: LoadContext): Promise<PageData> {
  const data = await ctx.gateway.get<Record<string, unknown>>('/api/v1/me/legal');
  const raw = get(data, 'pending');
  const pending = Array.isArray(raw)
    ? raw.map((document: unknown) => ({
        id: get(document, 'id'),
        path: `/legal/${encodeURIComponent(str(get(document, 'id')))}`,
        summary: str(get(document, 'summary')),
        effective: localDate(get(document, 'effective_at')),
      }))
    : [];
  return {
    ...identityData(ctx),
    documents: pending,
    documents_state: data === null ? 'error' : pending.length === 0 ? 'empty' : 'list',
  };
}

async function loadApps(ctx: LoadContext): Promise<PageData> {
  const data = await ctx.gateway.get<Record<string, unknown>>('/api/v1/oauth/authorized');
  const apps = itemsOf(data).map((item) => ({
    client_id: get(item, 'client_id'),
    name: str(get(item, 'name'), str(get(item, 'client_id'))),
  }));
  return {
    ...identityData(ctx),
    apps,
    apps_state: data === null ? 'error' : apps.length === 0 ? 'empty' : 'list',
  };
}

async function loadDeveloper(ctx: LoadContext): Promise<PageData> {
  const data = await ctx.gateway.get<Record<string, unknown>>('/api/v1/oauth/clients');
  const clients = itemsOf(data).map((item) => ({
    name: str(get(item, 'name')),
    client_id: str(get(item, 'client_id')),
  }));
  return {
    ...identityData(ctx),
    clients,
    clients_state: data === null ? 'error' : clients.length === 0 ? 'empty' : 'list',
  };
}

async function loadGames(ctx: LoadContext): Promise<PageData> {
  const data = await ctx.gateway.get<Record<string, unknown>>('/api/v1/games/owned');
  const library = itemsOf(data).map((item) => {
    const products = get(item, 'products');
    const productList = Array.isArray(products)
      ? products.map((product: unknown) => str(get(product, 'name'))).join(', ')
      : '';
    return { name: str(get(item, 'name')), products: productList };
  });
  return {
    ...identityData(ctx),
    library,
    library_state: data === null ? 'error' : library.length === 0 ? 'empty' : 'list',
  };
}

async function loadLegalDocument(ctx: LoadContext): Promise<PageData> {
  const id = ctx.params['id'] ?? '';
  const document = await ctx.gateway.get<Record<string, unknown>>(
    `/api/v1/legal/${encodeURIComponent(id)}`,
  );
  return {
    ...identityData(ctx),
    summary: str(get(document, 'summary')),
    version: str(get(document, 'version')),
    effective: localDate(get(document, 'effective_at')),
    body: str(get(document, 'body')),
    document_state: document === null ? 'error' : 'ready',
  };
}

async function loadAdminUsers(ctx: LoadContext): Promise<PageData> {
  const q = ctx.query.get('q');
  const data = await ctx.gateway.get<Record<string, unknown>>(
    q === null || q === '' ? '/api/v1/admin/users' : `/api/v1/admin/users?q=${encodeURIComponent(q)}`,
  );
  const users = itemsOf(data).map((item) => ({
    id: get(item, 'id'),
    username: str(get(item, 'username'), str(get(item, 'id'))),
    path: `/admin/users/${encodeURIComponent(str(get(item, 'id')))}`,
    status: str(get(item, 'account_state')),
  }));
  return {
    ...identityData(ctx),
    users,
    users_state: data === null ? 'error' : users.length === 0 ? 'empty' : 'list',
    query: q ?? '',
  };
}

async function loadAdminRoles(ctx: LoadContext): Promise<PageData> {
  const data = await ctx.gateway.get<Record<string, unknown>>('/api/v1/admin/roles');
  const roles = itemsOf(data).map((item) => ({
    name: str(get(item, 'name')),
    description: str(get(item, 'description')),
  }));
  return {
    ...identityData(ctx),
    roles,
    roles_state: data === null ? 'error' : roles.length === 0 ? 'empty' : 'list',
  };
}

async function loadAdminHealth(ctx: LoadContext): Promise<PageData> {
  const data = await ctx.gateway.get<Record<string, unknown>>('/api/v1/meta/health');
  return {
    ...identityData(ctx),
    overall: str(get(data, 'status'), 'unknown'),
    health_state: data === null ? 'error' : 'ready',
  };
}

async function loadKbHome(ctx: LoadContext): Promise<PageData> {
  const data = await ctx.gateway.get<Record<string, unknown>>('/api/v1/support/kb/categories');
  const categories = itemsOf(data).map((item) => ({
    slug: get(item, 'slug'),
    name: str(get(item, 'name')),
    path: `/kb/categories/${encodeURIComponent(str(get(item, 'slug')))}`,
  }));
  return {
    ...identityData(ctx),
    categories,
    categories_state: data === null ? 'error' : categories.length === 0 ? 'empty' : 'list',
  };
}

async function loadMyTickets(ctx: LoadContext): Promise<PageData> {
  const data = await ctx.gateway.get<Record<string, unknown>>('/api/v1/support/tickets');
  const tickets = itemsOf(data).map((item) => ({
    id: get(item, 'id'),
    subject: str(get(item, 'subject')),
    status: str(get(item, 'status')),
    path: `/tickets/${encodeURIComponent(str(get(item, 'id')))}`,
  }));
  return {
    ...identityData(ctx),
    tickets,
    tickets_state: data === null ? 'error' : tickets.length === 0 ? 'empty' : 'list',
  };
}

const LOADERS: Record<string, Loader> = {
  'sign-in': loadSignIn,
  'sign-up': loadSignUp,
  account: loadAccount,
  profile: loadProfile,
  email: loadBranding,
  security: loadBranding,
  sessions: loadSessions,
  methods: loadBranding,
  notifications: loadNotifications,
  legal: loadLegal,
  'legal-document': loadLegalDocument,
  data: loadBranding,
  family: loadFamily,
  'family-leave': loadBranding,
  apps: loadApps,
  developer: loadDeveloper,
  games: loadGames,
  'support-kb': loadKbHome,
  'support-tickets': loadMyTickets,
  'admin-users': loadAdminUsers,
  'admin-roles': loadAdminRoles,
  'admin-health': loadAdminHealth,
};

export async function loadPageData(name: string, ctx: LoadContext): Promise<PageData> {
  const loader = LOADERS[name] ?? loadBranding;
  try {
    return await loader(ctx);
  } catch {
    return identityData(ctx);
  }
}

export interface LoadContextOptions {
  baseUrl?: string;
}

export function makeLoadContext(
  request: Request,
  config: LoadContext['config'],
  params: PageParams,
  options: LoadContextOptions = {},
): LoadContext {
  const gatewayCtx =
    options.baseUrl === undefined
      ? { request, config }
      : { request, config, baseUrl: options.baseUrl };
  return {
    request,
    config,
    params,
    gateway: gatewayClient(gatewayCtx),
    query: new URL(request.url).searchParams,
  };
}
