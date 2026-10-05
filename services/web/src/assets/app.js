import { apiClient } from './client.js';
import { availablePages, matchPage, PAGES } from './pages.js';
import { mountPage, parseTemplates, problemAlert } from './view.js';

export { availablePages, matchPage, PAGES };

const BOOTSTRAP_SELECTOR = '#qtiauth-bootstrap';
const APP_SELECTOR = '#qtiauth-app';
const MAIN_SELECTOR = '#qtiauth-main';
const LIVE_SELECTOR = '#qtiauth-live';

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
    routes.push({ id: 'support', path: '/', surface: 'support' });
  }
  return routes.map((route) => ({
    ...route,
    href: surfaceHref(features, current, route.surface, route.path),
    cross_surface: route.surface !== current,
  }));
}

export function translator(catalogue) {
  return (key, fallback) => catalogue[key] ?? fallback ?? key;
}

function underBase(base, path) {
  return base === '/' || path === base || path.startsWith(`${base}/`);
}

export function currentSurface(features, location) {
  let best;
  for (const surface of features.surfaces) {
    if (!surface.origins.includes(location.origin)) continue;
    if (!underBase(surface.base_path, location.pathname)) continue;
    if (best === undefined || surface.base_path.length > best.base_path.length) best = surface;
  }
  return best ?? { name: 'account', base_path: '/' };
}

function currentPath(basePath, location) {
  const base = basePath === '/' ? '' : basePath;
  if (base === '' || !location.pathname.startsWith(base)) return location.pathname;
  return location.pathname.slice(base.length) || '/';
}

function joinBase(base, path) {
  if (base === '/' || base === '') return path;
  return `${base}${path}`;
}

function readBootstrap() {
  const node = document.querySelector(BOOTSTRAP_SELECTOR);
  if (node === null) return null;
  const parsed = JSON.parse(node.textContent ?? '{}');
  return {
    basePath: parsed.base_path ?? '/',
    locale: parsed.locale ?? 'en-GB',
    metaOrigin: parsed.meta_origin ?? null,
  };
}

async function fetchOk(url) {
  const response = await fetch(url, { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`Request to ${url} failed with ${String(response.status)}`);
  return response;
}

async function fetchJson(url) {
  return (await fetchOk(url)).json();
}

async function fetchText(url) {
  return (await fetchOk(url)).text();
}

function metaEndpoint(bootstrapData, path) {
  if (bootstrapData.metaOrigin === null) return joinBase(bootstrapData.basePath, path);
  return new URL(path.replace(/^\//, ''), `${bootstrapData.metaOrigin}/`).toString();
}

async function loadLocale(bootstrapData) {
  try {
    return await fetchJson(joinBase(bootstrapData.basePath, `/locales/${bootstrapData.locale}`));
  } catch {
    return {};
  }
}

async function loadTemplates(bootstrapData) {
  const html = await fetchText(joinBase(bootstrapData.basePath, '/templates.html'));
  return parseTemplates(html);
}

function announce(text) {
  const live = document.querySelector(LIVE_SELECTOR);
  if (live === null) return;
  live.textContent = '';
  window.setTimeout(() => {
    live.textContent = text;
  }, 50);
}

function postPreference(path, name, value) {
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = path;
  form.hidden = true;
  const field = document.createElement('input');
  field.type = 'hidden';
  field.name = name;
  field.value = value;
  const back = document.createElement('input');
  back.type = 'hidden';
  back.name = 'return_to';
  back.value = window.location.pathname + window.location.search;
  form.append(field, back);
  document.body.appendChild(form);
  form.submit();
}

function wireThemeToggle(root) {
  for (const button of root.querySelectorAll('[data-action="toggle-theme"]')) {
    if (button.dataset.wired === 'yes') continue;
    button.dataset.wired = 'yes';
    button.addEventListener('click', (event) => {
      event.preventDefault();
      const current =
        document.documentElement.getAttribute('data-theme') ??
        (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      const next = current === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      postPreference('/theme', 'theme', next);
    });
  }
}

function wireDialogs(root) {
  for (const trigger of root.querySelectorAll('[data-dialog-open]')) {
    if (trigger.dataset.wired === 'yes') continue;
    trigger.dataset.wired = 'yes';
    trigger.addEventListener('click', (event) => {
      event.preventDefault();
      const target = document.getElementById(trigger.dataset.dialogOpen ?? '');
      if (target instanceof HTMLDialogElement) target.showModal();
    });
  }
  for (const closer of root.querySelectorAll('[data-dialog-close]')) {
    if (closer.dataset.wired === 'yes') continue;
    closer.dataset.wired = 'yes';
    closer.addEventListener('click', (event) => {
      event.preventDefault();
      const target = closer.closest('dialog');
      if (target instanceof HTMLDialogElement) target.close();
    });
  }
}

function wireToastDismiss(root) {
  for (const toast of root.querySelectorAll('[data-toast] [data-action="dismiss"]')) {
    if (toast.dataset.wired === 'yes') continue;
    toast.dataset.wired = 'yes';
    toast.addEventListener('click', (event) => {
      event.preventDefault();
      const owner = toast.closest('[data-toast]');
      if (owner !== null) owner.remove();
    });
  }
}

function wireChrome(root) {
  wireThemeToggle(root);
  wireDialogs(root);
  wireToastDismiss(root);
}

let popstateHandler = null;

export async function bootstrap(config = {}) {
  const bootstrapData = config.bootstrap ?? readBootstrap();
  if (bootstrapData === null) return;
  const location = config.location ?? window.location;
  const history = config.history ?? window.history;
  const app = document.querySelector(APP_SELECTOR);
  const main = document.querySelector(MAIN_SELECTOR);
  if (app === null || main === null) return;

  let features;
  let templates;
  try {
    [features, templates] = await Promise.all([
      (config.fetchFeatures ?? fetchJson)(metaEndpoint(bootstrapData, '/api/v1/meta/features')),
      (config.loadTemplates ?? loadTemplates)(bootstrapData),
    ]);
  } catch {
    return;
  }
  const catalogue = await loadLocale(bootstrapData);
  const t = translator(catalogue);
  const surface = currentSurface(features, location);
  const current = surface.name;
  const pages = availablePages(features, current);
  const api = apiClient(bootstrapData);

  const renderCurrent = (path) => {
    const match = matchPage(pages, path);
    if (match === null) return;
    app.setAttribute('aria-busy', 'true');
    while (main.firstChild !== null) main.removeChild(main.firstChild);
    try {
      const view = mountPage(main, templates, match.page.id, t, ctx);
      match.page.render?.(view, t, ctx, match.params);
      announce(t(`routes.${match.page.id}.title`, match.page.id));
    } catch (error) {
      while (main.firstChild !== null) main.removeChild(main.firstChild);
      main.appendChild(
        problemAlert(t, { code: 'INTERNAL_ERROR', detail: String(error?.message ?? error) }),
      );
    }
    wireChrome(main);
    app.setAttribute('aria-busy', 'false');
    main.focus();
  };

  const ctx = {
    features,
    api,
    location,
    bootstrap: bootstrapData,
    surface: current,
    href: (path) => joinBase(surface.base_path, path),
    navigate: (path) => {
      history.pushState({}, '', joinBase(surface.base_path, path));
      renderCurrent(path);
    },
  };

  if (popstateHandler !== null) window.removeEventListener('popstate', popstateHandler);
  popstateHandler = () => renderCurrent(currentPath(surface.base_path, location));
  window.addEventListener('popstate', popstateHandler);
  renderCurrent(currentPath(surface.base_path, location));
}

if (typeof window !== 'undefined') {
  wireChrome(document);
  if (document.readyState !== 'loading') void bootstrap();
  else document.addEventListener('DOMContentLoaded', () => void bootstrap());
}
