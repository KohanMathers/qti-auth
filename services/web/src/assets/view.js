import { ProblemFetchError } from './client.js';
import { messageFor } from './problems.js';

const ELEMENT_NODE = 1;
const sources = new WeakMap();
const filled = new WeakMap();
const boundaries = new WeakSet();
const wired = new WeakSet();
const rowsOf = new WeakMap();

export function parseTemplates(html) {
  const holder = document.createElement('template');
  holder.innerHTML = html;
  const pages = new Map();
  const partials = new Map();
  for (const node of holder.content.children) {
    if (node.localName !== 'template') continue;
    if (node.dataset.page !== undefined) pages.set(node.dataset.page, node);
    else if (node.dataset.partial !== undefined) partials.set(node.dataset.partial, node);
  }
  return { pages, partials };
}

export function mountPage(main, templates, id, t, ctx) {
  const template = templates.pages.get(id);
  if (template === undefined) throw new Error(`No template for page ${id}`);
  const env = { t, ctx, partials: templates.partials };
  return createView(insert(main, template, null), env, null);
}

export function problemAlert(t, problem) {
  const catalogueEntry = messageFor(problem.code ?? 'INTERNAL_ERROR');
  const box = document.createElement('div');
  box.className = 'qtiauth-alert';
  box.setAttribute('role', 'alert');
  const title = document.createElement('h2');
  title.textContent = t(`problems.${problem.code}.title`, catalogueEntry.title);
  const detail = document.createElement('p');
  detail.textContent =
    problem.detail ?? t(`problems.${problem.code}.detail`, catalogueEntry.detail);
  box.append(title, detail);
  return box;
}

function insert(parent, template, before) {
  const clone = template.content.cloneNode(true);
  const nodes = Array.from(clone.childNodes);
  parent.insertBefore(clone, before);
  return nodes;
}

function elementsOf(nodes) {
  return nodes.filter((node) => node.nodeType === ELEMENT_NODE);
}

function normalise(text) {
  return text.replace(/\s+/gu, ' ').trim();
}

function interpolate(source, values) {
  return source.replace(/\{([a-z0-9_]+)\}/giu, (match, key) => {
    const value = values[key];
    return value === undefined || value === null ? match : String(value);
  });
}

function createView(nodes, env, parent) {
  const roots = elementsOf(nodes);
  const { t, ctx } = env;

  const owned = (el) => {
    for (let node = el; node !== null; node = node.parentElement) {
      if (roots.includes(node)) return true;
      if (boundaries.has(node)) return false;
    }
    return false;
  };

  const find = (selector) => {
    const out = [];
    for (const root of roots) {
      if (root.matches(selector)) out.push(root);
      for (const el of root.querySelectorAll(selector)) if (owned(el)) out.push(el);
    }
    return out;
  };

  const one = (selector, what) => {
    const [el] = find(selector);
    if (el === undefined) throw new Error(`Template has no ${what}`);
    return el;
  };

  const setLink = (anchor, path) => {
    anchor.dataset.path = path;
    anchor.setAttribute('href', ctx.href(path));
    if (wired.has(anchor)) return;
    wired.add(anchor);
    anchor.addEventListener('click', (event) => {
      event.preventDefault();
      ctx.navigate(anchor.dataset.path);
    });
  };

  const bind = (el, name, value) => {
    if (name === 'href' && el.hasAttribute('data-link')) {
      setLink(el, String(value));
      return;
    }
    if (value === false || value === null) el.removeAttribute(name);
    else el.setAttribute(name, value === true ? '' : String(value));
    if (name === 'value') el.value = value === null || value === false ? '' : String(value);
    if (name === 'checked') el.checked = Boolean(value);
  };

  const prepare = () => {
    for (const el of find('[data-t]')) {
      const text = t(el.dataset.t, normalise(el.textContent));
      sources.set(el, text);
      el.textContent = text;
    }
    for (const anchor of find('a[data-link]')) setLink(anchor, anchor.getAttribute('href'));
    for (const slot of find('[data-slot]')) {
      for (const child of slot.children) {
        if (child.dataset.state !== undefined) child.hidden = child.dataset.state !== 'loading';
      }
    }
  };

  const view = {
    t,
    nodes,
    get el() {
      return roots[0];
    },

    fill(values) {
      for (const el of find('[data-t]')) {
        const source = sources.get(el);
        if (source === undefined || !source.includes('{')) continue;
        const merged = { ...filled.get(el), ...values };
        filled.set(el, merged);
        el.textContent = interpolate(source, merged);
      }
      for (const el of find('[data-field]')) {
        const value = values[el.dataset.field];
        if (value !== undefined && value !== null) el.textContent = String(value);
      }
      for (const el of find('*')) {
        for (const attr of Array.from(el.attributes)) {
          if (!attr.name.startsWith('data-bind-')) continue;
          const value = values[attr.value];
          if (value !== undefined) bind(el, attr.name.slice('data-bind-'.length), value);
        }
      }
      return view;
    },

    show(flag, condition) {
      for (const el of find(`[data-show="${flag}"]`)) if (!condition) el.remove();
      for (const el of find(`[data-show="!${flag}"]`)) if (condition) el.remove();
      return view;
    },

    on(action, handler) {
      const targets = find(`[data-action="${action}"]`);
      if (targets.length === 0) throw new Error(`Template has no data-action="${action}"`);
      for (const target of targets) {
        target.addEventListener('click', (event) => handler(event, target));
      }
      return view;
    },

    form(name, handler) {
      const el = one(`form[data-form="${name}"]`, `form data-form="${name}"`);
      let feedback = el.querySelector('.qtiauth-feedback');
      if (feedback === null) {
        feedback = document.createElement('div');
        feedback.className = 'qtiauth-feedback';
        feedback.setAttribute('aria-live', 'polite');
        el.appendChild(feedback);
      }
      const form = {
        el,
        feedback,
        say: (message, values) => {
          const local = el.querySelector(`template[data-message="${message}"]`);
          feedback.appendChild(
            local === null ? view.message(message, values) : clone(local, values),
          );
        },
      };
      el.addEventListener('submit', (event) => {
        event.preventDefault();
        void runForm(el, feedback, t, () => handler(collect(el), form));
      });
      return form;
    },

    list(name, items, fill) {
      const template = one(`template[data-item="${name}"]`, `template data-item="${name}"`);
      for (const node of rowsOf.get(template) ?? []) node.remove();
      const inserted = [];
      const rows = items.map((item) => {
        const rowNodes = insert(template.parentNode, template, template);
        inserted.push(...rowNodes);
        for (const root of elementsOf(rowNodes)) boundaries.add(root);
        const row = createView(rowNodes, env, view);
        if (fill === undefined) row.fill(item);
        else fill(item, row);
        return row;
      });
      rowsOf.set(template, inserted);
      const [slot] = find(`[data-slot="${name}"]`);
      if (slot !== undefined) switchState(slot, items.length === 0 ? 'empty' : 'list');
      return rows;
    },

    state(slot, state) {
      const el = one(`[data-slot="${slot}"]`, `data-slot="${slot}"`);
      if (!switchState(el, state)) throw new Error(`Slot ${slot} has no data-state="${state}"`);
      return view;
    },

    part(name) {
      return one(`[data-part="${name}"]`, `data-part="${name}"`);
    },

    message(name, values) {
      const [template] = find(`template[data-message="${name}"]`);
      if (template !== undefined) return clone(template, values);
      if (parent !== null) return parent.message(name, values);
      throw new Error(`Template has no data-message="${name}"`);
    },

    say(part, name, values) {
      view.part(part).replaceChildren(view.message(name, values));
      return view;
    },

    include(part, partial) {
      const target = view.part(part);
      const template = env.partials.get(partial);
      if (template === undefined) throw new Error(`No partial named ${partial}`);
      target.replaceChildren();
      const included = insert(target, template, null);
      for (const root of elementsOf(included)) boundaries.add(root);
      return createView(included, env, view);
    },

    append(node) {
      roots[0].appendChild(node);
      return view;
    },

    remove() {
      for (const node of nodes) node.remove();
    },

    problem(problem = { code: 'INTERNAL_ERROR' }) {
      return problemAlert(t, problem);
    },
  };

  const clone = (template, values) => {
    const holder = document.createDocumentFragment();
    createView(insert(holder, template, null), env, view).fill(values ?? {});
    return holder;
  };

  prepare();
  return view;
}

function switchState(slot, state) {
  let found = false;
  for (const child of slot.children) {
    if (child.dataset.state === undefined) continue;
    child.hidden = child.dataset.state !== state;
    found ||= child.dataset.state === state;
  }
  return found;
}

function collect(form) {
  const values = {};
  for (const input of form.elements) {
    if (input.name === '' || input.type === 'submit' || input.type === 'button') continue;
    values[input.name] = input.type === 'checkbox' ? input.checked : input.value;
  }
  return values;
}

async function runForm(form, feedback, t, action) {
  form.setAttribute('aria-busy', 'true');
  feedback.replaceChildren();
  try {
    const result = await action();
    form.setAttribute('aria-busy', 'false');
    return result;
  } catch (error) {
    form.setAttribute('aria-busy', 'false');
    const problem = error instanceof ProblemFetchError ? error.problem : { code: 'INTERNAL_ERROR' };
    feedback.appendChild(problemAlert(t, problem));
    return undefined;
  }
}
