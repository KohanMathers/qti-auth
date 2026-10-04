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

function readFormValues(form) {
  const values = {};
  for (const input of form.elements) {
    if (input.name === '' || input.type === 'submit' || input.type === 'button') continue;
    values[input.name] = input.type === 'checkbox' ? input.checked : input.value;
  }
  return values;
}

async function submitForm(form) {
  const action = form.getAttribute('action') ?? window.location.pathname;
  const method = (form.getAttribute('method') ?? 'POST').toUpperCase();
  const payload = readFormValues(form);
  const response = await fetch(action, {
    method,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(payload),
  });
  return response;
}

function wireAsyncForms(root) {
  for (const form of root.querySelectorAll('form[data-form]')) {
    if (form.dataset.wired === 'yes') continue;
    form.dataset.wired = 'yes';
    form.addEventListener('submit', (event) => {
      if (!form.hasAttribute('data-async')) return;
      event.preventDefault();
      form.setAttribute('aria-busy', 'true');
      void submitForm(form)
        .then((response) => {
          form.setAttribute('aria-busy', 'false');
          if (response.redirected) {
            window.location.assign(response.url);
            return;
          }
          announce(form.dataset.announceSubmit ?? 'Saved');
        })
        .catch(() => {
          form.setAttribute('aria-busy', 'false');
          announce(form.dataset.announceError ?? 'Something went wrong');
        });
    });
  }
}

function focusMain() {
  const main = document.getElementById('qtiauth-main');
  if (main === null) return;
  main.focus();
}

function enhance() {
  wireThemeToggle(document);
  wireDialogs(document);
  wireToastDismiss(document);
  wireAsyncForms(document);
  focusMain();
}

if (typeof window !== 'undefined') {
  if (document.readyState !== 'loading') enhance();
  else document.addEventListener('DOMContentLoaded', enhance);
}
