import { messageFor } from './problems.js';

const BOOTSTRAP_SELECTOR = '#qtiauth-bootstrap';
const APP_SELECTOR = '#qtiauth-app';
const MAIN_SELECTOR = '#qtiauth-main';
const LIVE_SELECTOR = '#qtiauth-live';

function readBootstrap() {
  const node = document.querySelector(BOOTSTRAP_SELECTOR);
  if (node === null) throw new Error('Bootstrap script tag missing');
  const parsed = JSON.parse(node.textContent ?? '{}');
  return {
    basePath: parsed.base_path ?? '/',
    locale: parsed.locale ?? 'en-GB',
    metaOrigin: parsed.meta_origin ?? null,
  };
}

function joinBase(base, path) {
  if (base === '/' || base === '') return path;
  return `${base}${path}`;
}

async function fetchJson(url, init) {
  const response = await fetch(url, { credentials: 'same-origin', ...init });
  if (!response.ok) {
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/problem+json')) {
      const problem = await response.json();
      throw new ProblemFetchError(problem);
    }
    throw new ProblemFetchError({
      code: 'INTERNAL_ERROR',
      status: response.status,
      title: 'Something went wrong',
    });
  }
  return response.json();
}

export class ProblemFetchError extends Error {
  constructor(problem) {
    super(problem.title ?? 'Request failed');
    this.name = 'ProblemFetchError';
    this.problem = problem;
  }
}

function metaEndpoint(bootstrap, path) {
  if (bootstrap.metaOrigin === null) return joinBase(bootstrap.basePath, path);
  return new URL(path.replace(/^\//, ''), `${bootstrap.metaOrigin}/`).toString();
}

async function loadLocale(bootstrap) {
  try {
    return await fetchJson(joinBase(bootstrap.basePath, `/locales/${bootstrap.locale}`));
  } catch {
    return {};
  }
}

export function translator(catalogue) {
  return (key, fallback) => catalogue[key] ?? fallback ?? key;
}

function sameSitePair(pairs, from, to) {
  for (const pair of pairs) {
    const [a, b] = pair.surfaces;
    if ((a === from && b === to) || (a === to && b === from)) return pair.same_site;
  }
  return true;
}

function surfaceFor(features, name) {
  return features.surfaces.find((surface) => surface.name === name);
}

function currentSurface(features, location) {
  const { origin } = location;
  return features.surfaces.find((surface) => surface.origins.includes(origin))?.name ?? 'account';
}

export function surfaceHref(features, current, target, path) {
  if (current === target) return path;
  const same = sameSitePair(features.surface_pairs, current, target);
  const surface = surfaceFor(features, target);
  if (surface === undefined) return path;
  const base = surface.base_path === '/' ? '' : surface.base_path;
  const combined = `${base}${path}`;
  if (same) return combined;
  return new URL(combined, `${surface.origins[0] ?? ''}/`).toString();
}

export function availableRoutes(features, current) {
  const routes = [];
  if (features.modules.identity) {
    if (features.auth.methods.password || features.auth.methods.passkeys) {
      routes.push({ id: 'sign-in', path: '/sign-in', surface: 'account' });
    }
    routes.push({ id: 'account', path: '/account', surface: 'account' });
  }
  if (features.modules.games) routes.push({ id: 'games', path: '/games', surface: 'account' });
  if (features.modules.oidc) routes.push({ id: 'apps', path: '/apps', surface: 'account' });
  if (features.modules.support) {
    routes.push({ id: 'support', path: '/support', surface: 'support' });
  }
  return routes.map((route) => ({
    ...route,
    href: surfaceHref(features, current, route.surface, route.path),
    cross_surface: route.surface !== current,
  }));
}

function noop() {
  return undefined;
}

function element(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'text') node.textContent = value;
    else if (key === 'attrs') for (const [k, v] of Object.entries(value)) node.setAttribute(k, v);
    else node[key] = value;
  }
  for (const child of children) node.appendChild(child);
  return node;
}

function announce(text) {
  const live = document.querySelector(LIVE_SELECTOR);
  if (live === null) return;
  live.textContent = '';
  window.setTimeout(() => {
    live.textContent = text;
  }, 50);
}

function renderNav(main, routes, t, onNavigate) {
  const nav = element('nav', { attrs: { 'aria-label': t('nav.primary', 'Primary') } });
  const list = element('ul');
  for (const route of routes) {
    const link = element('a', {
      href: route.href,
      text: t(`nav.${route.id}`, route.id),
      attrs: route.cross_surface ? { rel: 'external', target: '_top' } : {},
    });
    if (!route.cross_surface) {
      link.addEventListener('click', (event) => {
        event.preventDefault();
        onNavigate(route);
      });
    }
    const item = element('li');
    item.appendChild(link);
    list.appendChild(item);
  }
  nav.appendChild(list);
  main.appendChild(nav);
}

function renderHeading(main, t, productName) {
  const heading = element('h1', { text: productName });
  main.appendChild(heading);
  const lede = element('p', {
    text: t('shell.tagline', 'Sign in, manage your account and get support.'),
  });
  main.appendChild(lede);
}

function renderProblem(main, t, problem) {
  const { title, detail } = messageFor(problem.code ?? 'INTERNAL_ERROR');
  const alert = element('div', {
    className: 'qtiauth-alert',
    attrs: { role: 'alert' },
  });
  const heading = element('h2', { text: t(`problems.${problem.code}.title`, title) });
  const body = element('p', {
    text: problem.detail ?? t(`problems.${problem.code}.detail`, detail),
  });
  alert.append(heading, body);
  main.appendChild(alert);
  announce(heading.textContent);
}

function renderRoute(main, t, features, route) {
  const heading = element('h2', { text: t(`routes.${route.id}.title`, route.id) });
  const body = element('p', {
    text: t(`routes.${route.id}.body`, `Screen: ${route.id}`),
  });
  main.append(heading, body);
  if (route.id === 'sign-in' && features.auth.social.length > 0) {
    const list = element('ul');
    for (const provider of features.auth.social) {
      const item = element('li', { text: provider.name });
      list.appendChild(item);
    }
    main.appendChild(list);
  }
}

function clear(node) {
  while (node.firstChild !== null) node.removeChild(node.firstChild);
}

function currentPath(bootstrap, location) {
  const base = bootstrap.basePath === '/' ? '' : bootstrap.basePath;
  if (base === '' || !location.pathname.startsWith(base)) return location.pathname;
  return location.pathname.slice(base.length) || '/';
}

function match(routes, path) {
  return routes.find((route) => route.path === path) ?? null;
}

export async function bootstrap(config) {
  const bootstrapData = config?.bootstrap ?? readBootstrap();
  const fetcher = config?.fetch ?? fetchJson;
  const location = config?.location ?? window.location;
  const app = document.querySelector(APP_SELECTOR);
  const main = document.querySelector(MAIN_SELECTOR);
  if (app === null || main === null) return;
  app.setAttribute('aria-busy', 'true');
  let features;
  try {
    features = await fetcher(metaEndpoint(bootstrapData, '/api/v1/meta/features'));
  } catch (error) {
    clear(main);
    const problem = error instanceof ProblemFetchError ? error.problem : { code: 'INTERNAL_ERROR' };
    renderProblem(main, translator({}), problem);
    app.setAttribute('aria-busy', 'false');
    return;
  }
  const catalogue = await loadLocale(bootstrapData);
  const t = translator(catalogue);
  const current = currentSurface(features, location);
  const routes = availableRoutes(features, current);
  const initialPath = currentPath(bootstrapData, location);
  const initial = match(routes, initialPath);
  clear(main);
  renderHeading(main, t, features.branding.product_name);
  renderNav(main, routes, t, (route) => {
    window.history.pushState({}, '', route.href);
    clear(main);
    renderHeading(main, t, features.branding.product_name);
    renderNav(main, routes, t, noop);
    renderRoute(main, t, features, route);
    main.focus();
    announce(t(`routes.${route.id}.title`, route.id));
  });
  if (initial !== null) renderRoute(main, t, features, initial);
  app.setAttribute('aria-busy', 'false');
}

if (typeof window !== 'undefined' && document.readyState !== 'loading') {
  bootstrap();
} else if (typeof window !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    void bootstrap();
  });
}
