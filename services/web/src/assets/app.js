import { apiClient, ProblemFetchError } from './client.js';
import { availablePages, clear, element, matchPage, PAGES } from './pages.js';
import { messageFor } from './problems.js';

const BOOTSTRAP_SELECTOR = '#qtiauth-bootstrap';
const APP_SELECTOR = '#qtiauth-app';
const MAIN_SELECTOR = '#qtiauth-main';
const LIVE_SELECTOR = '#qtiauth-live';

export { ProblemFetchError };

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

// Tracks the popstate listener installed by bootstrap so a second bootstrap()
// call (tests, hot-reload) does not stack duplicate handlers.
let popstateHandler = null;

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
  if (features.modules.admin) routes.push({ id: 'admin', path: '/admin', surface: 'account' });
  if (features.modules.support) {
    routes.push({ id: 'support', path: '/support', surface: 'support' });
  }
  return routes.map((route) => ({
    ...route,
    href: surfaceHref(features, current, route.surface, route.path),
    cross_surface: route.surface !== current,
  }));
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

function currentPath(bootstrap, location) {
  const base = bootstrap.basePath === '/' ? '' : bootstrap.basePath;
  if (base === '' || !location.pathname.startsWith(base)) return location.pathname;
  return location.pathname.slice(base.length) || '/';
}

function absoluteHref(bootstrap, path) {
  return joinBase(bootstrap.basePath, path);
}

export async function bootstrap(config) {
  const bootstrapData = config?.bootstrap ?? readBootstrap();
  const fetcher = config?.fetch ?? fetchJson;
  const location = config?.location ?? window.location;
  const history = config?.history ?? window.history;
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
    const t = translator({});
    renderProblem(main, t, problem);
    const retry = element('button', {
      type: 'button',
      text: t('shell.retry', 'Try again'),
    });
    retry.addEventListener('click', () => {
      void bootstrap(config);
    });
    main.appendChild(retry);
    app.setAttribute('aria-busy', 'false');
    return;
  }
  const catalogue = await loadLocale(bootstrapData);
  const t = translator(catalogue);
  const current = currentSurface(features, location);
  const routes = availableRoutes(features, current);
  const pages = availablePages(features);
  const api = apiClient(bootstrapData);
  const ctx = {
    features,
    api,
    apiBase: bootstrapData.metaOrigin ?? bootstrapData.basePath.replace(/\/$/, ''),
    location,
    bootstrap: bootstrapData,
    href: (path) => absoluteHref(bootstrapData, path),
    navigate: (path) => {
      history.pushState({}, '', absoluteHref(bootstrapData, path));
      renderCurrent(path);
    },
  };
  const renderCurrent = (path) => {
    clear(main);
    renderHeading(main, t, features.branding.product_name);
    renderNav(main, routes, t, (route) => ctx.navigate(route.path));
    const match = matchPage(pages, path);
    if (match !== null) {
      match.page.render(main, t, ctx, match.params);
      announce(t(`routes.${match.page.id}.title`, match.page.id));
    }
    main.focus();
  };
  if (popstateHandler !== null) {
    window.removeEventListener('popstate', popstateHandler);
  }
  popstateHandler = () => renderCurrent(currentPath(bootstrapData, location));
  window.addEventListener('popstate', popstateHandler);
  renderCurrent(currentPath(bootstrapData, location));
  app.setAttribute('aria-busy', 'false');
}

export { availablePages, matchPage, PAGES };

if (typeof window !== 'undefined' && document.readyState !== 'loading') {
  bootstrap();
} else if (typeof window !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    void bootstrap();
  });
}
