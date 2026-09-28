import {
  admin,
  apiClient,
  auth,
  family,
  games,
  me,
  oauth,
  ProblemFetchError,
  reports,
  sessions,
} from './client.js';
import { messageFor } from './problems.js';

export function element(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue;
    if (key === 'text') node.textContent = value;
    else if (key === 'attrs') for (const [k, v] of Object.entries(value)) node.setAttribute(k, v);
    else node[key] = value;
  }
  for (const child of children) if (child !== null) node.appendChild(child);
  return node;
}

export function clear(node) {
  while (node.firstChild !== null) node.removeChild(node.firstChild);
}

function field(t, spec) {
  const id = `qtiauth-f-${spec.name}`;
  const label = element('label', { htmlFor: id, text: t(spec.label, spec.name) });
  const input = element('input', {
    id,
    name: spec.name,
    type: spec.type ?? 'text',
    required: spec.required !== false,
    autocomplete: spec.autocomplete ?? 'off',
  });
  if (spec.value !== undefined) input.value = spec.value;
  if (spec.min !== undefined) input.minLength = spec.min;
  if (spec.pattern !== undefined) input.pattern = spec.pattern;
  const wrap = element('p', { className: 'qtiauth-field' });
  wrap.append(label, input);
  return { wrap, input };
}

function submitRow(t, label) {
  const row = element('p', { className: 'qtiauth-actions' });
  row.appendChild(element('button', { type: 'submit', text: t(label, 'Submit') }));
  return row;
}

function successRow(t, label) {
  return element('p', {
    className: 'qtiauth-success',
    attrs: { role: 'status' },
    text: t(label, 'Done.'),
  });
}

function problemAlert(t, problem) {
  const catalogueEntry = messageFor(problem.code ?? 'INTERNAL_ERROR');
  const box = element('div', {
    className: 'qtiauth-alert',
    attrs: { role: 'alert' },
  });
  box.append(
    element('h2', { text: t(`problems.${problem.code}.title`, catalogueEntry.title) }),
    element('p', {
      text: problem.detail ?? t(`problems.${problem.code}.detail`, catalogueEntry.detail),
    }),
  );
  return box;
}

async function runForm(form, feedback, t, action) {
  form.setAttribute('aria-busy', 'true');
  clear(feedback);
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

function heading(main, t, titleKey, fallback, description) {
  main.appendChild(element('h2', { text: t(titleKey, fallback) }));
  if (description !== undefined) {
    main.appendChild(element('p', { className: 'qtiauth-lede', text: t(description, '') }));
  }
}

function form(fields, t, submitLabel, onSubmit) {
  const feedback = element('div', {
    className: 'qtiauth-feedback',
    attrs: { 'aria-live': 'polite' },
  });
  const el = element('form', { noValidate: true });
  const inputs = new Map();
  for (const spec of fields) {
    const { wrap, input } = field(t, spec);
    el.appendChild(wrap);
    inputs.set(spec.name, input);
  }
  el.appendChild(submitRow(t, submitLabel));
  el.appendChild(feedback);
  el.addEventListener('submit', (event) => {
    event.preventDefault();
    const values = {};
    for (const [name, input] of inputs) values[name] = input.value;
    void runForm(el, feedback, t, () => onSubmit(values, { form: el, feedback }));
  });
  return el;
}

function list(items, render) {
  const ul = element('ul', { className: 'qtiauth-list' });
  for (const item of items) ul.appendChild(render(item));
  return ul;
}

function empty(t, key, fallback) {
  return element('p', { className: 'qtiauth-empty', text: t(key, fallback) });
}

function socialButtons(t, features, ctx) {
  if (features.auth.social.length === 0) return null;
  const wrap = element('div', { className: 'qtiauth-social' });
  wrap.appendChild(element('h3', { text: t('signIn.social', 'Continue with') }));
  const buttons = element('ul', { className: 'qtiauth-social-list' });
  for (const provider of features.auth.social) {
    const anchor = element('a', {
      href: `${ctx.apiBase}/api/v1/auth/social/${encodeURIComponent(provider.id)}/start`,
      className: 'qtiauth-button qtiauth-button-social',
      text: provider.name,
    });
    const item = element('li');
    item.appendChild(anchor);
    buttons.appendChild(item);
  }
  wrap.appendChild(buttons);
  return wrap;
}

function pageSignIn(main, t, ctx) {
  heading(main, t, 'routes.sign-in.title', 'Sign in', 'signIn.lede');
  const a = auth(ctx.api);
  if (ctx.features.auth.methods.password) {
    main.appendChild(
      element('h3', { text: t('signIn.password.heading', 'Sign in with password') }),
    );
    main.appendChild(
      form(
        [
          { name: 'email', type: 'email', label: 'field.email', autocomplete: 'email' },
          {
            name: 'password',
            type: 'password',
            label: 'field.password',
            autocomplete: 'current-password',
          },
        ],
        t,
        'signIn.submit',
        async (values, { feedback }) => {
          await a.signInPassword(values.email, values.password);
          feedback.appendChild(successRow(t, 'signIn.success'));
          ctx.navigate('/account');
        },
      ),
    );
    main.appendChild(
      element('p', {}, [
        element('a', {
          href: ctx.href('/forgot'),
          text: t('signIn.forgot', 'Forgot your password?'),
          onclick: (event) => {
            event.preventDefault();
            ctx.navigate('/forgot');
          },
        }),
      ]),
    );
  }
  if (ctx.features.auth.methods.magic_link) {
    main.appendChild(element('h3', { text: t('signIn.magic.heading', 'Sign in with a link') }));
    main.appendChild(
      form(
        [{ name: 'email', type: 'email', label: 'field.email', autocomplete: 'email' }],
        t,
        'signIn.magic.submit',
        async (values, { feedback }) => {
          await a.magicLinkStart(values.email);
          feedback.appendChild(successRow(t, 'signIn.magic.success'));
        },
      ),
    );
  }
  if (ctx.features.auth.methods.passkeys) {
    main.appendChild(
      element('h3', { text: t('signIn.passkey.heading', 'Sign in with a passkey') }),
    );
    main.appendChild(
      element('p', {
        text: t('signIn.passkey.body', 'Your device will prompt you to choose a passkey.'),
      }),
    );
    main.appendChild(
      element('button', {
        type: 'button',
        text: t('signIn.passkey.submit', 'Use a passkey'),
        onclick: () => {
          const feedback =
            main.querySelector('.qtiauth-feedback') ??
            main.appendChild(element('div', { className: 'qtiauth-feedback' }));
          feedback.appendChild(
            element('p', { text: t('signIn.passkey.pending', 'Passkey sign-in is coming soon.') }),
          );
        },
      }),
    );
  }
  const social = socialButtons(t, ctx.features, ctx);
  if (social !== null) main.appendChild(social);
  main.appendChild(
    element('p', {}, [
      element('a', {
        href: ctx.href('/sign-up'),
        text: t('signIn.newHere', 'Create an account'),
        onclick: (event) => {
          event.preventDefault();
          ctx.navigate('/sign-up');
        },
      }),
    ]),
  );
}

function pageSignUp(main, t, ctx) {
  heading(main, t, 'routes.sign-up.title', 'Create an account', 'signUp.lede');
  const a = auth(ctx.api);
  if (ctx.features.auth.methods.password) {
    main.appendChild(
      form(
        [
          { name: 'name', label: 'field.name', autocomplete: 'name' },
          { name: 'email', type: 'email', label: 'field.email', autocomplete: 'email' },
          {
            name: 'password',
            type: 'password',
            label: 'field.password',
            autocomplete: 'new-password',
            min: 12,
          },
        ],
        t,
        'signUp.submit',
        async (values, { feedback }) => {
          await a.signUpPassword(values.email, values.password, values.name);
          feedback.appendChild(successRow(t, 'signUp.success'));
          ctx.navigate('/verify');
        },
      ),
    );
  }
  if (ctx.features.auth.methods.magic_link && !ctx.features.auth.methods.password) {
    main.appendChild(
      form(
        [
          { name: 'name', label: 'field.name', autocomplete: 'name' },
          { name: 'email', type: 'email', label: 'field.email', autocomplete: 'email' },
        ],
        t,
        'signUp.magic.submit',
        async (values, { feedback }) => {
          await a.magicLinkStart(values.email);
          feedback.appendChild(successRow(t, 'signUp.magic.success'));
        },
      ),
    );
  }
}

function pageVerify(main, t, ctx) {
  heading(main, t, 'routes.verify.title', 'Verify your email', 'verify.lede');
  const a = auth(ctx.api);
  main.appendChild(
    form(
      [{ name: 'token', label: 'field.token', autocomplete: 'one-time-code' }],
      t,
      'verify.submit',
      async (values, { feedback }) => {
        await a.verifyEmail(values.token);
        feedback.appendChild(successRow(t, 'verify.success'));
        ctx.navigate('/account');
      },
    ),
  );
  main.appendChild(
    element('button', {
      type: 'button',
      className: 'qtiauth-button qtiauth-button-ghost',
      text: t('verify.resend', 'Send a new email'),
      onclick: () => {
        void a.startVerifyEmail();
      },
    }),
  );
}

function pageForgot(main, t, ctx) {
  heading(main, t, 'routes.forgot.title', 'Reset your password', 'forgot.lede');
  const a = auth(ctx.api);
  main.appendChild(
    form(
      [{ name: 'email', type: 'email', label: 'field.email', autocomplete: 'email' }],
      t,
      'forgot.submit',
      async (values, { feedback }) => {
        await a.forgot(values.email);
        feedback.appendChild(successRow(t, 'forgot.success'));
      },
    ),
  );
}

function pageReset(main, t, ctx) {
  heading(main, t, 'routes.reset.title', 'Choose a new password', 'reset.lede');
  const a = auth(ctx.api);
  main.appendChild(
    form(
      [
        { name: 'token', label: 'field.token', autocomplete: 'one-time-code' },
        {
          name: 'password',
          type: 'password',
          label: 'field.password',
          autocomplete: 'new-password',
          min: 12,
        },
      ],
      t,
      'reset.submit',
      async (values, { feedback }) => {
        await a.reset(values.token, values.password);
        feedback.appendChild(successRow(t, 'reset.success'));
        ctx.navigate('/sign-in');
      },
    ),
  );
}

function pageAccount(main, t, ctx) {
  heading(main, t, 'routes.account.title', 'Your account', 'routes.account.body');
  const sections = [
    { path: '/account/profile', label: 'account.section.profile' },
    { path: '/account/email', label: 'account.section.email' },
    { path: '/account/security', label: 'account.section.security' },
    { path: '/account/sessions', label: 'account.section.sessions' },
    { path: '/account/methods', label: 'account.section.methods' },
    { path: '/account/notifications', label: 'account.section.notifications' },
    { path: '/account/legal', label: 'account.section.legal' },
    { path: '/account/data', label: 'account.section.data' },
  ];
  main.appendChild(
    list(sections, (section) => {
      const item = element('li');
      item.appendChild(
        element('a', {
          href: ctx.href(section.path),
          text: t(section.label, section.path),
          onclick: (event) => {
            event.preventDefault();
            ctx.navigate(section.path);
          },
        }),
      );
      return item;
    }),
  );
  const a = auth(ctx.api);
  main.appendChild(
    element('button', {
      type: 'button',
      className: 'qtiauth-button qtiauth-button-ghost',
      text: t('account.signOut', 'Sign out'),
      onclick: () => {
        void a.signOut().then(() => ctx.navigate('/sign-in'));
      },
    }),
  );
}

function pageProfile(main, t, ctx) {
  heading(main, t, 'routes.profile.title', 'Profile', 'profile.lede');
  const account = me(ctx.api);
  const details = element('dl', { className: 'qtiauth-details' });
  main.appendChild(details);
  void account
    .get()
    .then((data) => {
      const entries = [
        ['profile.field.name', data?.name ?? ''],
        ['profile.field.username', data?.username ?? ''],
        ['profile.field.email', data?.email ?? ''],
      ];
      for (const [key, value] of entries) {
        details.append(element('dt', { text: t(key, key) }), element('dd', { text: value }));
      }
    })
    .catch(() => {
      details.appendChild(
        element('dd', { text: t('profile.load.error', 'Could not load profile.') }),
      );
    });
  main.appendChild(element('h3', { text: t('profile.username.heading', 'Change username') }));
  main.appendChild(
    form(
      [{ name: 'username', label: 'field.username', autocomplete: 'username' }],
      t,
      'profile.username.submit',
      async (values, { feedback }) => {
        await account.setUsername(values.username);
        feedback.appendChild(successRow(t, 'profile.username.success'));
      },
    ),
  );
}

function pageEmail(main, t, ctx) {
  heading(main, t, 'routes.email.title', 'Change email', 'email.lede');
  const a = auth(ctx.api);
  main.appendChild(
    form(
      [
        { name: 'email', type: 'email', label: 'field.email.new', autocomplete: 'email' },
        {
          name: 'password',
          type: 'password',
          label: 'field.password',
          autocomplete: 'current-password',
        },
      ],
      t,
      'email.submit',
      async (values, { feedback }) => {
        await a.changeEmail(values.email, values.password);
        feedback.appendChild(successRow(t, 'email.success'));
      },
    ),
  );
}

function pageSecurity(main, t, ctx) {
  heading(main, t, 'routes.security.title', 'Security', 'security.lede');
  const a = auth(ctx.api);
  main.appendChild(element('h3', { text: t('security.password.heading', 'Change password') }));
  main.appendChild(
    form(
      [
        {
          name: 'current',
          type: 'password',
          label: 'field.password.current',
          autocomplete: 'current-password',
        },
        {
          name: 'next',
          type: 'password',
          label: 'field.password.new',
          autocomplete: 'new-password',
          min: 12,
        },
      ],
      t,
      'security.password.submit',
      async (values, { feedback }) => {
        await a.changePassword(values.current, values.next);
        feedback.appendChild(successRow(t, 'security.password.success'));
      },
    ),
  );
  main.appendChild(
    element('h3', { text: t('security.twoFactor.heading', 'Two-factor authentication') }),
  );
  main.appendChild(
    element('p', {
      text: t(
        'security.twoFactor.body',
        'Add an authenticator app or passkey to protect sign-ins.',
      ),
    }),
  );
  main.appendChild(element('h3', { text: t('security.recovery.heading', 'Recovery codes') }));
  main.appendChild(
    element('p', {
      text: t(
        'security.recovery.body',
        'Generate one-time codes to sign in if you lose your device.',
      ),
    }),
  );
}

function pageSessions(main, t, ctx) {
  heading(main, t, 'routes.sessions.title', 'Signed-in sessions', 'sessions.lede');
  const s = sessions(ctx.api);
  const wrap = element('div', { className: 'qtiauth-sessions' });
  main.appendChild(wrap);
  const load = () => {
    clear(wrap);
    void s
      .list()
      .then((data) => {
        const items = data?.items ?? [];
        if (items.length === 0) {
          wrap.appendChild(empty(t, 'sessions.empty', 'No other sessions.'));
          return;
        }
        wrap.appendChild(
          list(items, (session) => {
            const item = element('li', { className: 'qtiauth-session' });
            item.append(
              element('span', {
                className: 'qtiauth-session-label',
                text: `${session.user_agent ?? 'unknown'} — ${session.ip ?? ''}`,
              }),
              element('button', {
                type: 'button',
                text: t('sessions.revoke', 'Revoke'),
                onclick: () => {
                  void s.revoke(session.id).then(load);
                },
              }),
            );
            return item;
          }),
        );
      })
      .catch(() => {
        wrap.appendChild(empty(t, 'sessions.load.error', 'Could not load sessions.'));
      });
  };
  load();
  main.appendChild(
    element('button', {
      type: 'button',
      className: 'qtiauth-button qtiauth-button-ghost',
      text: t('sessions.revokeOthers', 'Sign out other sessions'),
      onclick: () => {
        void s.revokeOthers().then(load);
      },
    }),
  );
}

function pageMethods(main, t, ctx) {
  heading(main, t, 'routes.methods.title', 'Connected sign-in methods', 'methods.lede');
  const methods = ctx.features.auth.methods;
  const rows = [
    { key: 'password', enabled: methods.password },
    { key: 'magic_link', enabled: methods.magic_link },
    { key: 'passkeys', enabled: methods.passkeys },
    { key: 'totp', enabled: methods.totp },
  ];
  main.appendChild(
    list(rows, (row) => {
      const item = element('li');
      const label = t(`methods.${row.key}`, row.key);
      const state = row.enabled ? t('methods.on', 'on') : t('methods.off', 'off');
      item.textContent = `${label} — ${state}`;
      return item;
    }),
  );
}

function pageNotifications(main, t, ctx) {
  heading(main, t, 'routes.notifications.title', 'Notification preferences', 'notifications.lede');
  const account = me(ctx.api);
  const wrap = element('form', { className: 'qtiauth-prefs' });
  main.appendChild(wrap);
  void account.notifications().then((data) => {
    clear(wrap);
    const preferences = data?.preferences ?? {};
    const channels = Object.entries(preferences);
    if (channels.length === 0) {
      wrap.appendChild(empty(t, 'notifications.empty', 'No preferences yet.'));
      return;
    }
    for (const [channel, value] of channels) {
      const id = `qtiauth-p-${channel}`;
      const box = element('p', { className: 'qtiauth-field' });
      box.append(
        element('input', { id, name: channel, type: 'checkbox', checked: Boolean(value) }),
        element('label', { htmlFor: id, text: t(`notifications.channel.${channel}`, channel) }),
      );
      wrap.appendChild(box);
    }
    const feedback = element('div', { className: 'qtiauth-feedback' });
    wrap.appendChild(submitRow(t, 'notifications.submit'));
    wrap.appendChild(feedback);
    wrap.addEventListener('submit', (event) => {
      event.preventDefault();
      const values = {};
      for (const input of wrap.querySelectorAll('input[type=checkbox]')) {
        values[input.name] = input.checked;
      }
      void runForm(wrap, feedback, t, async () => {
        await account.setNotifications(values);
        feedback.appendChild(successRow(t, 'notifications.success'));
      });
    });
  });
}

function pageLegal(main, t, ctx) {
  heading(main, t, 'routes.legal.title', 'Legal acceptance', 'legal.lede');
  const account = me(ctx.api);
  const wrap = element('div');
  main.appendChild(wrap);
  void account.legal().then((data) => {
    const documents = data?.documents ?? [];
    if (documents.length === 0) {
      wrap.appendChild(empty(t, 'legal.empty', 'No documents require acceptance.'));
      return;
    }
    wrap.appendChild(
      list(documents, (document) => {
        const item = element('li', { className: 'qtiauth-legal-item' });
        item.append(
          element('a', {
            href: document.url,
            text: document.title,
            attrs: { target: '_blank', rel: 'noopener' },
          }),
          element('button', {
            type: 'button',
            text: t('legal.accept', 'Accept'),
            onclick: () => {
              void account
                .acceptLegal(document.id, document.version)
                .then(() => item.appendChild(successRow(t, 'legal.accepted')));
            },
          }),
        );
        return item;
      }),
    );
  });
}

function pageData(main, t, ctx) {
  heading(main, t, 'routes.data.title', 'Data export and deletion', 'data.lede');
  const account = me(ctx.api);
  main.appendChild(element('h3', { text: t('data.export.heading', 'Export your data') }));
  const exportStatus = element('div', {
    className: 'qtiauth-status',
    attrs: { 'aria-live': 'polite' },
  });
  main.appendChild(exportStatus);
  main.appendChild(
    element('button', {
      type: 'button',
      text: t('data.export.submit', 'Request export'),
      onclick: () => {
        clear(exportStatus);
        void account
          .export()
          .then((result) => {
            exportStatus.appendChild(
              element('p', {
                text: t('data.export.queued', `Export queued: ${result?.id ?? ''}`),
              }),
            );
          })
          .catch(() => {
            exportStatus.appendChild(problemAlert(t, { code: 'INTERNAL_ERROR' }));
          });
      },
    }),
  );
  main.appendChild(element('h3', { text: t('data.deletion.heading', 'Delete your account') }));
  const deletionStatus = element('div', {
    className: 'qtiauth-status',
    attrs: { 'aria-live': 'polite' },
  });
  main.appendChild(deletionStatus);
  main.appendChild(
    element('button', {
      type: 'button',
      className: 'qtiauth-button qtiauth-button-danger',
      text: t('data.deletion.submit', 'Request deletion'),
      onclick: () => {
        clear(deletionStatus);
        void account.requestDeletion().then((result) => {
          deletionStatus.appendChild(
            element('p', {
              text: t('data.deletion.queued', `Scheduled for ${result?.scheduled_at ?? 'soon'}`),
            }),
          );
        });
      },
    }),
  );
}

function pageFamily(main, t, ctx) {
  heading(main, t, 'routes.family.title', 'Family dashboard', 'family.lede');
  const f = family(ctx.api);
  const wrap = element('div');
  main.appendChild(wrap);
  void f.list().then((data) => {
    const children = data?.children ?? [];
    if (children.length === 0) {
      wrap.appendChild(empty(t, 'family.empty', 'No linked children.'));
      return;
    }
    wrap.appendChild(
      list(children, (child) => {
        const item = element('li');
        item.appendChild(
          element('a', {
            href: ctx.href(`/family/${encodeURIComponent(child.id)}`),
            text: child.display_name ?? child.username ?? child.id,
            onclick: (event) => {
              event.preventDefault();
              ctx.navigate(`/family/${encodeURIComponent(child.id)}`);
            },
          }),
        );
        return item;
      }),
    );
  });
}

function pageChild(main, t, ctx, params) {
  heading(main, t, 'routes.family.child.title', 'Child dashboard', 'family.child.lede');
  const f = family(ctx.api);
  const details = element('dl', { className: 'qtiauth-details' });
  main.appendChild(details);
  void f.child(params.id).then((data) => {
    const rows = [
      ['family.field.username', data?.username ?? ''],
      ['family.field.age_band', data?.age_band ?? ''],
      ['family.field.status', data?.status ?? ''],
    ];
    for (const [key, value] of rows) {
      details.append(element('dt', { text: t(key, key) }), element('dd', { text: value }));
    }
  });
}

function pageChildWaiting(main, t) {
  heading(main, t, 'routes.waiting.title', 'Waiting for a guardian');
  main.appendChild(
    element('p', {
      text: t(
        'waiting.body',
        'Ask a parent or guardian to approve your account. This page will refresh when they do.',
      ),
    }),
  );
}

function pageConsent(main, t, ctx) {
  heading(main, t, 'routes.consent.title', 'Authorize app', 'consent.lede');
  const query = new URLSearchParams(ctx.location.search);
  const clientId = query.get('client_id') ?? '';
  const scope = query.get('scope') ?? '';
  main.appendChild(
    element('dl', { className: 'qtiauth-details' }, [
      element('dt', { text: t('consent.field.app', 'App') }),
      element('dd', { text: clientId }),
      element('dt', { text: t('consent.field.scope', 'Requested access') }),
      element('dd', { text: scope }),
    ]),
  );
  main.appendChild(
    element('form', { method: 'post', action: `${ctx.apiBase}/api/v1/oauth/authorize` }, [
      element('input', { type: 'hidden', name: 'client_id', value: clientId }),
      element('input', { type: 'hidden', name: 'scope', value: scope }),
      element('button', {
        type: 'submit',
        name: 'decision',
        value: 'allow',
        text: t('consent.allow', 'Allow'),
      }),
      element('button', {
        type: 'submit',
        className: 'qtiauth-button qtiauth-button-ghost',
        name: 'decision',
        value: 'deny',
        text: t('consent.deny', 'Deny'),
      }),
    ]),
  );
}

function pageDevice(main, t, ctx) {
  heading(main, t, 'routes.device.title', 'Enter device code', 'device.lede');
  const o = oauth(ctx.api);
  main.appendChild(
    form(
      [{ name: 'user_code', label: 'field.userCode', autocomplete: 'one-time-code' }],
      t,
      'device.submit',
      async (values, { feedback }) => {
        await o.devicePair(values.user_code);
        feedback.appendChild(successRow(t, 'device.success'));
      },
    ),
  );
}

function pageApps(main, t, ctx) {
  heading(main, t, 'routes.apps.title', 'Authorised apps', 'routes.apps.body');
  const o = oauth(ctx.api);
  const wrap = element('div');
  main.appendChild(wrap);
  void o.authorizedApps().then((data) => {
    const apps = data?.items ?? [];
    if (apps.length === 0) {
      wrap.appendChild(empty(t, 'apps.empty', 'No apps are connected.'));
      return;
    }
    wrap.appendChild(
      list(apps, (app) => {
        const item = element('li');
        item.append(
          element('span', { text: app.client_name ?? app.client_id }),
          element('button', {
            type: 'button',
            text: t('apps.revoke', 'Revoke'),
            onclick: () => {
              void o.revokeApp(app.client_id).then(() => item.remove());
            },
          }),
        );
        return item;
      }),
    );
  });
}

function pageDeveloper(main, t, ctx) {
  heading(main, t, 'routes.developer.title', 'Developer portal', 'developer.lede');
  const o = oauth(ctx.api);
  const wrap = element('div');
  main.appendChild(wrap);
  void o.developerClients().then((data) => {
    const clients = data?.items ?? [];
    if (clients.length === 0) {
      wrap.appendChild(empty(t, 'developer.empty', 'No OAuth clients yet.'));
    } else {
      wrap.appendChild(
        list(clients, (item) => {
          const row = element('li');
          row.append(
            element('span', { text: item.name ?? item.client_id }),
            element('span', { className: 'qtiauth-muted', text: item.client_id }),
          );
          return row;
        }),
      );
    }
    main.appendChild(
      element('h3', { text: t('developer.create.heading', 'Register a new client') }),
    );
    main.appendChild(
      form(
        [
          { name: 'name', label: 'field.clientName' },
          { name: 'redirect_uris', label: 'field.redirectUris' },
        ],
        t,
        'developer.create.submit',
        async (values, { feedback }) => {
          await o.createClient({
            name: values.name,
            redirect_uris: values.redirect_uris.split(/\s+/u).filter(Boolean),
          });
          feedback.appendChild(successRow(t, 'developer.create.success'));
        },
      ),
    );
  });
}

function pageGames(main, t, ctx) {
  heading(main, t, 'routes.games.title', 'Games', 'routes.games.body');
  const g = games(ctx.api);
  const wrap = element('div');
  main.appendChild(wrap);
  void g.library().then((data) => {
    const owned = data?.items ?? [];
    if (owned.length === 0) {
      wrap.appendChild(empty(t, 'games.empty', 'No games in your library yet.'));
      return;
    }
    wrap.appendChild(
      list(owned, (entry) => {
        const item = element('li');
        item.textContent = entry.title ?? entry.game_id;
        return item;
      }),
    );
  });
  const sub = [
    ['/games/redeem', 'games.section.redeem'],
    ['/games/achievements', 'games.section.achievements'],
    ['/games/stats', 'games.section.stats'],
    ['/games/leaderboards', 'games.section.leaderboards'],
    ['/games/devices', 'games.section.devices'],
  ];
  main.appendChild(
    list(sub, ([path, label]) => {
      const item = element('li');
      item.appendChild(
        element('a', {
          href: ctx.href(path),
          text: t(label, path),
          onclick: (event) => {
            event.preventDefault();
            ctx.navigate(path);
          },
        }),
      );
      return item;
    }),
  );
}

function pageRedeem(main, t, ctx) {
  heading(main, t, 'routes.redeem.title', 'Redeem a key', 'redeem.lede');
  const g = games(ctx.api);
  main.appendChild(
    form(
      [{ name: 'code', label: 'field.key', autocomplete: 'off' }],
      t,
      'redeem.submit',
      async (values, { feedback }) => {
        const result = await g.redeem(values.code);
        feedback.appendChild(
          element('p', {
            className: 'qtiauth-success',
            attrs: { role: 'status' },
            text: t('redeem.success', `Added ${result?.title ?? 'game'} to your library.`),
          }),
        );
      },
    ),
  );
}

function pageDevices(main, t, ctx) {
  heading(main, t, 'routes.devices.title', 'Game devices', 'devices.lede');
  const g = games(ctx.api);
  const wrap = element('div');
  main.appendChild(wrap);
  void g.devices().then((data) => {
    const devices = data?.items ?? [];
    if (devices.length === 0) {
      wrap.appendChild(empty(t, 'devices.empty', 'No linked devices.'));
      return;
    }
    wrap.appendChild(
      list(devices, (device) => {
        const item = element('li');
        item.append(
          element('span', { text: `${device.name ?? device.id} — ${device.platform ?? ''}` }),
          element('button', {
            type: 'button',
            text: t('devices.revoke', 'Revoke'),
            onclick: () => {
              void g.revokeDevice(device.id).then(() => item.remove());
            },
          }),
        );
        return item;
      }),
    );
  });
}

function gamePickerPage(main, t, ctx, action, titleKey, fallback) {
  heading(main, t, titleKey, fallback);
  const g = games(ctx.api);
  const output = element('div', { className: 'qtiauth-status' });
  main.appendChild(
    form([{ name: 'game_id', label: 'field.game' }], t, 'games.load', async (values) => {
      clear(output);
      const data = await action(g, values.game_id);
      const items = data?.items ?? [];
      if (items.length === 0) {
        output.appendChild(empty(t, 'games.section.empty', 'Nothing to show.'));
        return;
      }
      output.appendChild(
        list(items, (row) => {
          const item = element('li');
          item.textContent = row.title ?? row.name ?? JSON.stringify(row);
          return item;
        }),
      );
    }),
  );
  main.appendChild(output);
}

function pageAchievements(main, t, ctx) {
  gamePickerPage(
    main,
    t,
    ctx,
    (g, id) => g.achievements(id),
    'routes.achievements.title',
    'Achievements',
  );
}

function pageStats(main, t, ctx) {
  gamePickerPage(main, t, ctx, (g, id) => g.stats(id), 'routes.stats.title', 'Stats');
}

function pageLeaderboards(main, t, ctx) {
  gamePickerPage(
    main,
    t,
    ctx,
    (g, id) => g.leaderboards(id),
    'routes.leaderboards.title',
    'Leaderboards',
  );
}

function pageReport(main, t, ctx) {
  heading(main, t, 'routes.report.title', 'Report user or content', 'report.lede');
  const r = reports(ctx.api);
  main.appendChild(
    form(
      [
        { name: 'target', label: 'field.target' },
        { name: 'reason', label: 'field.reason' },
        { name: 'detail', label: 'field.detail', required: false },
      ],
      t,
      'report.submit',
      async (values, { feedback }) => {
        await r.submit({ target: values.target, reason: values.reason, detail: values.detail });
        feedback.appendChild(successRow(t, 'report.success'));
      },
    ),
  );
}

function adminIndex(main, t, ctx) {
  heading(main, t, 'routes.admin.title', 'Administration', 'admin.lede');
  const sections = [
    ['/admin/users', 'admin.section.users'],
    ['/admin/roles', 'admin.section.roles'],
    ['/admin/audit', 'admin.section.audit'],
    ['/admin/webhooks', 'admin.section.webhooks'],
    ['/admin/filter', 'admin.section.filter'],
    ['/admin/moderation', 'admin.section.moderation'],
    ['/admin/csea', 'admin.section.csea'],
    ['/admin/oauth', 'admin.section.oauth'],
    ['/admin/games', 'admin.section.games'],
    ['/admin/health', 'admin.section.health'],
  ];
  main.appendChild(
    list(sections, ([path, label]) => {
      const item = element('li');
      item.appendChild(
        element('a', {
          href: ctx.href(path),
          text: t(label, path),
          onclick: (event) => {
            event.preventDefault();
            ctx.navigate(path);
          },
        }),
      );
      return item;
    }),
  );
}

function adminList(main, t, ctx, loader, titleKey, fallback, render) {
  heading(main, t, titleKey, fallback);
  const wrap = element('div');
  main.appendChild(wrap);
  void loader(admin(ctx.api))
    .then((data) => {
      const items = data?.items ?? data ?? [];
      const rows = Array.isArray(items) ? items : [];
      if (rows.length === 0) {
        wrap.appendChild(empty(t, 'admin.empty', 'Nothing to show.'));
        return;
      }
      wrap.appendChild(list(rows, render));
    })
    .catch(() => {
      wrap.appendChild(empty(t, 'admin.load.error', 'Could not load data.'));
    });
}

function pageAdminUsers(main, t, ctx) {
  adminList(
    main,
    t,
    ctx,
    (a) => a.users(),
    'routes.admin.users.title',
    'Users',
    (user) => {
      const item = element('li');
      item.textContent = `${user.username ?? user.id} — ${user.email ?? ''}`;
      return item;
    },
  );
}

function pageAdminRoles(main, t, ctx) {
  adminList(
    main,
    t,
    ctx,
    (a) => a.roles(),
    'routes.admin.roles.title',
    'Roles',
    (role) => {
      const item = element('li');
      item.textContent = `${role.name ?? role.id}`;
      return item;
    },
  );
}

function pageAdminAudit(main, t, ctx) {
  adminList(
    main,
    t,
    ctx,
    (a) => a.audit(),
    'routes.admin.audit.title',
    'Audit',
    (entry) => {
      const item = element('li');
      item.textContent = `${entry.at ?? ''} — ${entry.action ?? ''} — ${entry.actor ?? ''}`;
      return item;
    },
  );
}

function pageAdminWebhooks(main, t, ctx) {
  adminList(
    main,
    t,
    ctx,
    (a) => a.webhooks(),
    'routes.admin.webhooks.title',
    'Webhooks',
    (hook) => {
      const item = element('li');
      item.textContent = `${hook.url ?? hook.id} — ${(hook.events ?? []).join(', ')}`;
      return item;
    },
  );
}

function pageAdminFilter(main, t, ctx) {
  heading(main, t, 'routes.admin.filter.title', 'Text filter tuning');
  const a = admin(ctx.api);
  const wrap = element('div');
  main.appendChild(wrap);
  const sections = [
    ['admin.filter.blocks', () => a.filterBlocks()],
    ['admin.filter.allowlist', () => a.filterAllowlist()],
    ['admin.filter.blocklist', () => a.filterBlocklist()],
  ];
  for (const [label, loader] of sections) {
    wrap.appendChild(element('h3', { text: t(label, label) }));
    const box = element('div');
    wrap.appendChild(box);
    void loader().then((data) => {
      const rows = data?.items ?? [];
      if (rows.length === 0) {
        box.appendChild(empty(t, 'admin.empty', 'Nothing to show.'));
      } else {
        box.appendChild(
          list(rows, (row) => {
            const item = element('li');
            item.textContent = row.word ?? row.pattern ?? JSON.stringify(row);
            return item;
          }),
        );
      }
    });
  }
}

function pageAdminModeration(main, t, ctx) {
  adminList(
    main,
    t,
    ctx,
    (a) => a.moderationQueue(),
    'routes.admin.moderation.title',
    'Moderation queue',
    (row) => {
      const item = element('li');
      item.textContent = `${row.kind ?? ''} — ${row.target ?? ''}`;
      return item;
    },
  );
}

function pageAdminCsea(main, t, ctx) {
  adminList(
    main,
    t,
    ctx,
    (a) => a.cseaCases(),
    'routes.admin.csea.title',
    'CSEA cases',
    (row) => {
      const item = element('li');
      item.textContent = `${row.opened_at ?? ''} — ${row.status ?? ''}`;
      return item;
    },
  );
}

function pageAdminOauth(main, t, ctx) {
  adminList(
    main,
    t,
    ctx,
    (a) => a.oauthClients(),
    'routes.admin.oauth.title',
    'OAuth client verification',
    (row) => {
      const item = element('li');
      item.textContent = `${row.name ?? row.client_id} — ${row.status ?? ''}`;
      return item;
    },
  );
}

function pageAdminGames(main, t, ctx) {
  adminList(
    main,
    t,
    ctx,
    (a) => a.gamesCatalog(),
    'routes.admin.games.title',
    'Games catalog',
    (row) => {
      const item = element('li');
      item.textContent = `${row.title ?? row.id}`;
      return item;
    },
  );
}

function pageAdminHealth(main, t, ctx) {
  heading(main, t, 'routes.admin.health.title', 'Service health');
  const wrap = element('dl', { className: 'qtiauth-details' });
  main.appendChild(wrap);
  void admin(ctx.api)
    .health()
    .then((data) => {
      const services = data?.services ?? [];
      for (const service of services) {
        wrap.append(element('dt', { text: service.name }), element('dd', { text: service.status }));
      }
    })
    .catch(() => {
      wrap.append(
        element('dt', { text: t('admin.health.title', 'Status') }),
        element('dd', { text: t('admin.load.error', 'Could not load data.') }),
      );
    });
}

export const PAGES = Object.freeze({
  'sign-in': { path: '/sign-in', render: pageSignIn, requires: { auth: true } },
  'sign-up': { path: '/sign-up', render: pageSignUp, requires: { auth: true } },
  verify: { path: '/verify', render: pageVerify },
  forgot: { path: '/forgot', render: pageForgot, requires: { password: true } },
  reset: { path: '/reset', render: pageReset, requires: { password: true } },
  account: { path: '/account', render: pageAccount, requires: { identity: true } },
  profile: { path: '/account/profile', render: pageProfile, requires: { identity: true } },
  email: { path: '/account/email', render: pageEmail, requires: { identity: true } },
  security: { path: '/account/security', render: pageSecurity, requires: { identity: true } },
  sessions: { path: '/account/sessions', render: pageSessions, requires: { identity: true } },
  methods: { path: '/account/methods', render: pageMethods, requires: { identity: true } },
  notifications: {
    path: '/account/notifications',
    render: pageNotifications,
    requires: { identity: true },
  },
  legal: { path: '/account/legal', render: pageLegal, requires: { identity: true } },
  data: { path: '/account/data', render: pageData, requires: { identity: true } },
  family: { path: '/family', render: pageFamily, requires: { identity: true } },
  child: { path: '/family/:id', render: pageChild, requires: { identity: true } },
  waiting: { path: '/waiting', render: pageChildWaiting },
  consent: { path: '/consent', render: pageConsent, requires: { oidc: true } },
  device: { path: '/device', render: pageDevice, requires: { oidc: true } },
  apps: { path: '/apps', render: pageApps, requires: { oidc: true } },
  developer: { path: '/developer', render: pageDeveloper, requires: { oidc: true } },
  games: { path: '/games', render: pageGames, requires: { games: true } },
  redeem: { path: '/games/redeem', render: pageRedeem, requires: { games: true } },
  achievements: {
    path: '/games/achievements',
    render: pageAchievements,
    requires: { games: true },
  },
  stats: { path: '/games/stats', render: pageStats, requires: { games: true } },
  leaderboards: {
    path: '/games/leaderboards',
    render: pageLeaderboards,
    requires: { games: true },
  },
  devices: { path: '/games/devices', render: pageDevices, requires: { games: true } },
  report: { path: '/report', render: pageReport, requires: { safety: true } },
  admin: { path: '/admin', render: adminIndex, requires: { admin: true } },
  'admin-users': { path: '/admin/users', render: pageAdminUsers, requires: { admin: true } },
  'admin-roles': { path: '/admin/roles', render: pageAdminRoles, requires: { admin: true } },
  'admin-audit': { path: '/admin/audit', render: pageAdminAudit, requires: { admin: true } },
  'admin-webhooks': {
    path: '/admin/webhooks',
    render: pageAdminWebhooks,
    requires: { admin: true },
  },
  'admin-filter': { path: '/admin/filter', render: pageAdminFilter, requires: { admin: true } },
  'admin-moderation': {
    path: '/admin/moderation',
    render: pageAdminModeration,
    requires: { admin: true },
  },
  'admin-csea': { path: '/admin/csea', render: pageAdminCsea, requires: { admin: true } },
  'admin-oauth': { path: '/admin/oauth', render: pageAdminOauth, requires: { admin: true } },
  'admin-games': { path: '/admin/games', render: pageAdminGames, requires: { admin: true } },
  'admin-health': { path: '/admin/health', render: pageAdminHealth, requires: { admin: true } },
});

function moduleEnabled(features, requires) {
  if (requires === undefined) return true;
  if (requires.identity && !features.modules.identity) return false;
  if (requires.oidc && !features.modules.oidc) return false;
  if (requires.games && !features.modules.games) return false;
  if (requires.safety && !features.modules.safety) return false;
  if (requires.admin && !features.modules.admin) return false;
  if (requires.password && !features.auth.methods.password) return false;
  if (requires.auth) {
    const methods = features.auth.methods;
    if (!methods.password && !methods.magic_link && !methods.passkeys) return false;
  }
  return true;
}

export function availablePages(features) {
  const out = [];
  for (const [id, page] of Object.entries(PAGES)) {
    if (moduleEnabled(features, page.requires)) out.push({ id, ...page });
  }
  return out;
}

export function matchPage(pages, path) {
  for (const page of pages) {
    const params = pathMatch(page.path, path);
    if (params !== null) return { page, params };
  }
  return null;
}

export function pathMatch(pattern, path) {
  const patternParts = pattern.split('/').filter(Boolean);
  const pathParts = path.split('/').filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;
  const params = {};
  for (let i = 0; i < patternParts.length; i += 1) {
    const p = patternParts[i];
    const v = pathParts[i];
    if (p.startsWith(':')) params[p.slice(1)] = decodeURIComponent(v);
    else if (p !== v) return null;
  }
  return params;
}

export function apiFor(bootstrap, fetcher) {
  return apiClient(bootstrap, fetcher);
}

export function renderPage(main, t, features, page, params, ctx) {
  clear(main);
  page.render(main, t, ctx, params);
  main.focus();
}
